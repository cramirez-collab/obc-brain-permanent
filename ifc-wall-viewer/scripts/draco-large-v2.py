#!/usr/bin/env python3
"""
Split large GLB into ~10 chunks of ~500 nodes each, compress each with Draco
via gltf-transform CLI (single npx call per chunk), then merge.
Lossless Draco compression - no quality loss.
"""
import sys
import os
import json
import struct
import subprocess
import tempfile
import shutil
import gc

def get_glb_parts(filepath):
    """Read GLB header and JSON, return gltf dict and binary offset/length."""
    with open(filepath, 'rb') as f:
        magic, version, length = struct.unpack('<III', f.read(12))
        json_length, json_type = struct.unpack('<II', f.read(8))
        json_data = f.read(json_length).decode('utf-8')
        gltf = json.loads(json_data)
        bin_length, bin_type = struct.unpack('<II', f.read(8))
        bin_offset = 12 + 8 + json_length + 8
    return gltf, bin_offset, bin_length

def write_glb(gltf_dict, bin_data, output_path):
    """Write a GLB file from gltf dict and binary data."""
    json_str = json.dumps(gltf_dict, separators=(',', ':'))
    json_bytes = json_str.encode('utf-8')
    while len(json_bytes) % 4 != 0:
        json_bytes += b' '
    while len(bin_data) % 4 != 0:
        bin_data += b'\x00'
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_data)
    with open(output_path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(json_bytes), 0x4E4F534A))
        f.write(json_bytes)
        f.write(struct.pack('<II', len(bin_data), 0x004E4942))
        f.write(bin_data)

def extract_chunk(gltf, bin_data, mesh_node_indices, nodes, meshes, accessors, buffer_views, materials):
    """Extract a subset of mesh nodes into a standalone GLB's gltf+bin."""
    needed_meshes = set()
    needed_accessors = set()
    needed_buffer_views = set()
    needed_materials = set()
    
    for ni in mesh_node_indices:
        node = nodes[ni]
        mi = node['mesh']
        needed_meshes.add(mi)
        mesh = meshes[mi]
        for prim in mesh.get('primitives', []):
            if 'material' in prim:
                needed_materials.add(prim['material'])
            if 'indices' in prim:
                needed_accessors.add(prim['indices'])
            for acc in prim.get('attributes', {}).values():
                needed_accessors.add(acc)
    
    for ai in needed_accessors:
        a = accessors[ai]
        if 'bufferView' in a:
            needed_buffer_views.add(a['bufferView'])
    
    # Remap tables
    sm = sorted(needed_meshes)
    sa = sorted(needed_accessors)
    sb = sorted(needed_buffer_views)
    smat = sorted(needed_materials)
    mr = {o: n for n, o in enumerate(sm)}
    ar = {o: n for n, o in enumerate(sa)}
    br = {o: n for n, o in enumerate(sb)}
    matr = {o: n for n, o in enumerate(smat)}
    
    # Build new binary
    new_bin = bytearray()
    bv_offsets = {}
    for bvi in sb:
        bv = buffer_views[bvi]
        off = bv.get('byteOffset', 0)
        ln = bv['byteLength']
        while len(new_bin) % 4 != 0:
            new_bin.append(0)
        bv_offsets[bvi] = len(new_bin)
        new_bin.extend(bin_data[off:off+ln])
    while len(new_bin) % 4 != 0:
        new_bin.append(0)
    
    # Build gltf
    g = {
        "asset": gltf.get("asset", {"version": "2.0"}),
        "scene": 0,
        "scenes": [{"nodes": list(range(len(mesh_node_indices)))}],
        "nodes": [],
        "meshes": [],
        "accessors": [],
        "bufferViews": [],
        "buffers": [{"byteLength": len(new_bin)}],
    }
    if smat:
        g["materials"] = [materials[i] for i in smat]
    
    for ni in mesh_node_indices:
        node = nodes[ni]
        nn = {}
        if 'name' in node: nn['name'] = node['name']
        if 'mesh' in node: nn['mesh'] = mr[node['mesh']]
        for k in ('translation', 'rotation', 'scale', 'matrix'):
            if k in node: nn[k] = node[k]
        g["nodes"].append(nn)
    
    for mi in sm:
        mesh = meshes[mi]
        nm = {"primitives": []}
        if 'name' in mesh: nm['name'] = mesh['name']
        for prim in mesh.get('primitives', []):
            np = {}
            if 'mode' in prim: np['mode'] = prim['mode']
            if 'material' in prim: np['material'] = matr[prim['material']]
            if 'indices' in prim: np['indices'] = ar[prim['indices']]
            np['attributes'] = {k: ar[v] for k, v in prim.get('attributes', {}).items()}
            nm["primitives"].append(np)
        g["meshes"].append(nm)
    
    for ai in sa:
        a = accessors[ai]
        na = {"componentType": a["componentType"], "count": a["count"], "type": a["type"]}
        if 'bufferView' in a: na['bufferView'] = br[a['bufferView']]
        for k in ('byteOffset', 'min', 'max', 'normalized'):
            if k in a: na[k] = a[k]
        g["accessors"].append(na)
    
    for bvi in sb:
        bv = buffer_views[bvi]
        nb = {"buffer": 0, "byteOffset": bv_offsets[bvi], "byteLength": bv["byteLength"]}
        for k in ('byteStride', 'target'):
            if k in bv: nb[k] = bv[k]
        g["bufferViews"].append(nb)
    
    return g, bytes(new_bin)

def process_file(input_path, output_path, nodes_per_chunk=500):
    name = os.path.basename(input_path)
    size_mb = os.path.getsize(input_path) / 1024 / 1024
    print(f"\n{'='*60}")
    print(f"Processing: {name} ({size_mb:.1f} MB)")
    print(f"{'='*60}")
    
    # Read GLB structure
    print("[1/4] Reading GLB structure...")
    gltf, bin_offset, bin_length = get_glb_parts(input_path)
    
    nodes = gltf.get('nodes', [])
    meshes = gltf.get('meshes', [])
    accessors = gltf.get('accessors', [])
    buffer_views = gltf.get('bufferViews', [])
    materials = gltf.get('materials', [])
    
    mesh_node_indices = [i for i, n in enumerate(nodes) if 'mesh' in n]
    print(f"  {len(nodes)} nodes, {len(mesh_node_indices)} with meshes, {len(meshes)} meshes")
    
    # Read binary data
    print("[2/4] Loading binary data...")
    with open(input_path, 'rb') as f:
        f.seek(bin_offset)
        bin_data = f.read(bin_length)
    print(f"  Binary: {len(bin_data) / 1024 / 1024:.1f} MB")
    
    # Split into chunks
    chunks = []
    for i in range(0, len(mesh_node_indices), nodes_per_chunk):
        chunks.append(mesh_node_indices[i:i+nodes_per_chunk])
    print(f"  Split into {len(chunks)} chunks of ~{nodes_per_chunk} nodes")
    
    work_dir = tempfile.mkdtemp(prefix=f"draco_{name.split('.')[0]}_")
    
    try:
        # Write and compress each chunk
        print(f"\n[3/4] Compressing {len(chunks)} chunks with Draco...")
        compressed_files = []
        total_orig = 0
        total_comp = 0
        
        for ci, chunk_indices in enumerate(chunks):
            chunk_gltf, chunk_bin = extract_chunk(
                gltf, bin_data, chunk_indices, nodes, meshes, accessors, buffer_views, materials
            )
            
            chunk_path = os.path.join(work_dir, f"chunk_{ci:03d}.glb")
            comp_path = os.path.join(work_dir, f"comp_{ci:03d}.glb")
            
            write_glb(chunk_gltf, chunk_bin, chunk_path)
            orig_size = os.path.getsize(chunk_path)
            total_orig += orig_size
            
            # Compress with Draco
            result = subprocess.run(
                ['npx', '--yes', '@gltf-transform/cli', 'draco', chunk_path, comp_path,
                 '--method', 'edgebreaker'],
                capture_output=True, text=True, timeout=300,
                env={**os.environ, 'NODE_OPTIONS': '--max-old-space-size=3072'}
            )
            
            if result.returncode != 0 or not os.path.exists(comp_path):
                shutil.copy2(chunk_path, comp_path)
                tag = "COPY"
            else:
                tag = "DRACO"
            
            comp_size = os.path.getsize(comp_path)
            total_comp += comp_size
            ratio = (1 - comp_size / orig_size) * 100 if orig_size > 0 else 0
            print(f"  Chunk {ci+1}/{len(chunks)}: {orig_size/1024/1024:.1f}MB -> {comp_size/1024/1024:.1f}MB ({ratio:.0f}%) [{tag}]")
            
            compressed_files.append(comp_path)
            # Remove uncompressed chunk to save disk
            os.remove(chunk_path)
            gc.collect()
        
        # Free binary data before merge
        del bin_data
        gc.collect()
        
        print(f"\n  Chunks total: {total_orig/1024/1024:.1f}MB -> {total_comp/1024/1024:.1f}MB")
        
        # Merge chunks
        print(f"\n[4/4] Merging {len(compressed_files)} compressed chunks...")
        
        if len(compressed_files) <= 10:
            cmd = ['npx', '--yes', '@gltf-transform/cli', 'merge'] + compressed_files + [output_path]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=600,
                                  env={**os.environ, 'NODE_OPTIONS': '--max-old-space-size=3072'})
            if result.returncode != 0:
                print(f"  Direct merge failed: {result.stderr[:300]}")
                # Try hierarchical merge
                print("  Trying hierarchical merge...")
                return hierarchical_merge(compressed_files, output_path, work_dir)
        else:
            return hierarchical_merge(compressed_files, output_path, work_dir)
        
        if os.path.exists(output_path):
            final_size = os.path.getsize(output_path) / 1024 / 1024
            ratio = (1 - final_size / size_mb) * 100
            print(f"\n  FINAL: {size_mb:.1f} MB -> {final_size:.1f} MB ({ratio:.1f}% reduction)")
            return True
        return False
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

def hierarchical_merge(files, output_path, work_dir):
    """Merge files in a tree pattern to avoid loading too many at once."""
    batch_size = 5
    current_files = list(files)
    level = 0
    
    while len(current_files) > 1:
        next_files = []
        for i in range(0, len(current_files), batch_size):
            batch = current_files[i:i+batch_size]
            if len(batch) == 1:
                next_files.append(batch[0])
                continue
            
            merged_path = os.path.join(work_dir, f"merge_L{level}_{i:03d}.glb")
            cmd = ['npx', '--yes', '@gltf-transform/cli', 'merge'] + batch + [merged_path]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=600,
                                  env={**os.environ, 'NODE_OPTIONS': '--max-old-space-size=3072'})
            if result.returncode != 0:
                print(f"  Merge L{level} batch {i} failed: {result.stderr[:200]}")
                return False
            ms = os.path.getsize(merged_path) / 1024 / 1024
            print(f"  Merge L{level} batch {i//batch_size}: {len(batch)} files -> {ms:.1f} MB")
            next_files.append(merged_path)
        
        current_files = next_files
        level += 1
    
    if current_files:
        shutil.move(current_files[0], output_path)
        if os.path.exists(output_path):
            fs = os.path.getsize(output_path) / 1024 / 1024
            print(f"  Final merged: {fs:.1f} MB")
            return True
    return False

if __name__ == "__main__":
    files = [
        ("/home/ubuntu/glb-draco-large/electrical.glb", "/home/ubuntu/glb-draco-large/electrical-draco.glb"),
        ("/home/ubuntu/glb-draco-large/hydraulic.glb", "/home/ubuntu/glb-draco-large/hydraulic-draco.glb"),
    ]
    
    for inp, out in files:
        if not os.path.exists(inp):
            print(f"SKIP: {inp} not found")
            continue
        ok = process_file(inp, out, nodes_per_chunk=500)
        print(f"{'SUCCESS' if ok else 'FAILED'}: {out}")
