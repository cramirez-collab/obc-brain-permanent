#!/usr/bin/env python3
"""
Split large GLB files into smaller mesh groups, compress each with Draco via
gltf-transform CLI, then merge back into a single GLB.

This avoids OOM by never loading the full file into gltf-transform at once.
Uses pygltflib for low-level GLB manipulation.
"""
import sys
import os
import json
import struct
import subprocess
import tempfile
import shutil
from pathlib import Path

def get_glb_info(filepath):
    """Read GLB header and JSON chunk to get mesh/accessor info without loading binary."""
    with open(filepath, 'rb') as f:
        # GLB header: magic(4) + version(4) + length(4)
        magic, version, length = struct.unpack('<III', f.read(12))
        assert magic == 0x46546C67, "Not a valid GLB file"
        
        # JSON chunk header: length(4) + type(4)
        json_length, json_type = struct.unpack('<II', f.read(8))
        assert json_type == 0x4E4F534A, "First chunk must be JSON"
        
        json_data = f.read(json_length).decode('utf-8')
        gltf = json.loads(json_data)
        
        # Binary chunk header
        bin_length, bin_type = struct.unpack('<II', f.read(8))
        assert bin_type == 0x004E4942, "Second chunk must be BIN"
        bin_offset = 12 + 8 + json_length + 8  # offset to binary data start
        
    return gltf, bin_offset, bin_length

def split_glb_by_nodes(input_path, output_dir, max_nodes_per_chunk=50):
    """Split GLB into chunks by node groups."""
    gltf, bin_offset, bin_length = get_glb_info(input_path)
    
    nodes = gltf.get('nodes', [])
    meshes = gltf.get('meshes', [])
    accessors = gltf.get('accessors', [])
    buffer_views = gltf.get('bufferViews', [])
    materials = gltf.get('materials', [])
    
    print(f"  GLB info: {len(nodes)} nodes, {len(meshes)} meshes, {len(accessors)} accessors")
    print(f"  Binary data: {bin_length / 1024 / 1024:.1f} MB at offset {bin_offset}")
    
    # Find which nodes have meshes
    mesh_nodes = [(i, n) for i, n in enumerate(nodes) if 'mesh' in n]
    print(f"  Mesh nodes: {len(mesh_nodes)}")
    
    if len(mesh_nodes) == 0:
        print("  No mesh nodes found, cannot split")
        return []
    
    # Group mesh nodes into chunks
    chunks = []
    for i in range(0, len(mesh_nodes), max_nodes_per_chunk):
        chunk_nodes = mesh_nodes[i:i + max_nodes_per_chunk]
        chunks.append(chunk_nodes)
    
    print(f"  Splitting into {len(chunks)} chunks of ~{max_nodes_per_chunk} mesh nodes each")
    
    # For each chunk, create a standalone GLB with only those meshes
    chunk_files = []
    
    with open(input_path, 'rb') as f:
        f.seek(bin_offset)
        bin_data = f.read(bin_length)
    
    print(f"  Loaded binary data: {len(bin_data) / 1024 / 1024:.1f} MB")
    
    for ci, chunk_nodes in enumerate(chunks):
        # Collect all meshes, accessors, buffer views needed for this chunk
        needed_meshes = set()
        needed_accessors = set()
        needed_buffer_views = set()
        needed_materials = set()
        
        for node_idx, node in chunk_nodes:
            mesh_idx = node['mesh']
            needed_meshes.add(mesh_idx)
            mesh = meshes[mesh_idx]
            for prim in mesh.get('primitives', []):
                if 'material' in prim:
                    needed_materials.add(prim['material'])
                if 'indices' in prim:
                    needed_accessors.add(prim['indices'])
                for attr_acc in prim.get('attributes', {}).values():
                    needed_accessors.add(attr_acc)
        
        for acc_idx in needed_accessors:
            acc = accessors[acc_idx]
            if 'bufferView' in acc:
                needed_buffer_views.add(acc['bufferView'])
        
        # Build remapping tables
        mesh_remap = {}
        acc_remap = {}
        bv_remap = {}
        mat_remap = {}
        
        sorted_meshes = sorted(needed_meshes)
        sorted_accs = sorted(needed_accessors)
        sorted_bvs = sorted(needed_buffer_views)
        sorted_mats = sorted(needed_materials)
        
        for new_idx, old_idx in enumerate(sorted_meshes):
            mesh_remap[old_idx] = new_idx
        for new_idx, old_idx in enumerate(sorted_accs):
            acc_remap[old_idx] = new_idx
        for new_idx, old_idx in enumerate(sorted_bvs):
            bv_remap[old_idx] = new_idx
        for new_idx, old_idx in enumerate(sorted_mats):
            mat_remap[old_idx] = new_idx
        
        # Build new binary buffer with only needed buffer views, packed contiguously
        new_bin = bytearray()
        new_bv_offsets = {}
        
        for old_bv_idx in sorted_bvs:
            bv = buffer_views[old_bv_idx]
            offset = bv.get('byteOffset', 0)
            length = bv['byteLength']
            # Align to 4 bytes
            while len(new_bin) % 4 != 0:
                new_bin.append(0)
            new_bv_offsets[old_bv_idx] = len(new_bin)
            new_bin.extend(bin_data[offset:offset + length])
        
        # Pad to 4-byte alignment
        while len(new_bin) % 4 != 0:
            new_bin.append(0)
        
        # Build new GLTF JSON
        new_gltf = {
            "asset": gltf.get("asset", {"version": "2.0", "generator": "split-compress"}),
            "scene": 0,
            "scenes": [{"nodes": list(range(len(chunk_nodes)))}],
            "nodes": [],
            "meshes": [],
            "accessors": [],
            "bufferViews": [],
            "buffers": [{"byteLength": len(new_bin)}],
        }
        
        if sorted_mats:
            new_gltf["materials"] = []
            for old_mat_idx in sorted_mats:
                new_gltf["materials"].append(materials[old_mat_idx])
        
        # Add nodes
        for node_idx, node in chunk_nodes:
            new_node = {}
            if 'name' in node:
                new_node['name'] = node['name']
            if 'mesh' in node:
                new_node['mesh'] = mesh_remap[node['mesh']]
            if 'translation' in node:
                new_node['translation'] = node['translation']
            if 'rotation' in node:
                new_node['rotation'] = node['rotation']
            if 'scale' in node:
                new_node['scale'] = node['scale']
            if 'matrix' in node:
                new_node['matrix'] = node['matrix']
            new_gltf["nodes"].append(new_node)
        
        # Add meshes
        for old_mesh_idx in sorted_meshes:
            mesh = meshes[old_mesh_idx]
            new_mesh = {"primitives": []}
            if 'name' in mesh:
                new_mesh['name'] = mesh['name']
            for prim in mesh.get('primitives', []):
                new_prim = {}
                if 'mode' in prim:
                    new_prim['mode'] = prim['mode']
                if 'material' in prim:
                    new_prim['material'] = mat_remap[prim['material']]
                if 'indices' in prim:
                    new_prim['indices'] = acc_remap[prim['indices']]
                new_attrs = {}
                for attr_name, acc_idx in prim.get('attributes', {}).items():
                    new_attrs[attr_name] = acc_remap[acc_idx]
                new_prim['attributes'] = new_attrs
                new_mesh["primitives"].append(new_prim)
            new_gltf["meshes"].append(new_mesh)
        
        # Add accessors
        for old_acc_idx in sorted_accs:
            acc = accessors[old_acc_idx]
            new_acc = {
                "componentType": acc["componentType"],
                "count": acc["count"],
                "type": acc["type"],
            }
            if 'bufferView' in acc:
                new_acc['bufferView'] = bv_remap[acc['bufferView']]
            if 'byteOffset' in acc:
                new_acc['byteOffset'] = acc['byteOffset']
            if 'min' in acc:
                new_acc['min'] = acc['min']
            if 'max' in acc:
                new_acc['max'] = acc['max']
            if 'normalized' in acc:
                new_acc['normalized'] = acc['normalized']
            new_gltf["accessors"].append(new_acc)
        
        # Add buffer views
        for old_bv_idx in sorted_bvs:
            bv = buffer_views[old_bv_idx]
            new_bv = {
                "buffer": 0,
                "byteOffset": new_bv_offsets[old_bv_idx],
                "byteLength": bv["byteLength"],
            }
            if 'byteStride' in bv:
                new_bv['byteStride'] = bv['byteStride']
            if 'target' in bv:
                new_bv['target'] = bv['target']
            new_gltf["bufferViews"].append(new_bv)
        
        # Write chunk GLB
        json_str = json.dumps(new_gltf, separators=(',', ':'))
        json_bytes = json_str.encode('utf-8')
        # Pad JSON to 4-byte alignment with spaces
        while len(json_bytes) % 4 != 0:
            json_bytes += b' '
        
        chunk_path = os.path.join(output_dir, f"chunk_{ci:03d}.glb")
        with open(chunk_path, 'wb') as f:
            total_length = 12 + 8 + len(json_bytes) + 8 + len(new_bin)
            # GLB header
            f.write(struct.pack('<III', 0x46546C67, 2, total_length))
            # JSON chunk
            f.write(struct.pack('<II', len(json_bytes), 0x4E4F534A))
            f.write(json_bytes)
            # BIN chunk
            f.write(struct.pack('<II', len(new_bin), 0x004E4942))
            f.write(new_bin)
        
        chunk_size = os.path.getsize(chunk_path) / 1024 / 1024
        print(f"  Chunk {ci}: {len(chunk_nodes)} nodes, {len(sorted_meshes)} meshes, {chunk_size:.1f} MB")
        chunk_files.append(chunk_path)
    
    # Free binary data
    del bin_data
    
    return chunk_files

def compress_chunk_draco(input_path, output_path):
    """Compress a single chunk GLB with Draco using gltf-transform."""
    result = subprocess.run(
        ['npx', '--yes', '@gltf-transform/cli', 'draco', input_path, output_path,
         '--method', 'edgebreaker'],
        capture_output=True, text=True, timeout=300,
        env={**os.environ, 'NODE_OPTIONS': '--max-old-space-size=3072'}
    )
    if result.returncode != 0:
        print(f"    Draco failed: {result.stderr[:200]}")
        # Fallback: copy original
        shutil.copy2(input_path, output_path)
        return False
    return True

def merge_glbs(chunk_files, output_path):
    """Merge multiple GLB chunks back into a single GLB."""
    # Use gltf-transform merge
    if len(chunk_files) <= 5:
        # Small number of chunks, merge all at once
        cmd = ['npx', '--yes', '@gltf-transform/cli', 'merge'] + chunk_files + [output_path]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600,
                              env={**os.environ, 'NODE_OPTIONS': '--max-old-space-size=3072'})
        if result.returncode != 0:
            print(f"  Merge failed: {result.stderr[:300]}")
            return False
        return True
    else:
        # Many chunks: merge in batches
        batch_size = 5
        temp_merges = []
        for i in range(0, len(chunk_files), batch_size):
            batch = chunk_files[i:i + batch_size]
            if len(batch) == 1:
                temp_merges.append(batch[0])
                continue
            temp_out = chunk_files[0].replace('chunk_000', f'batch_{i:03d}')
            cmd = ['npx', '--yes', '@gltf-transform/cli', 'merge'] + batch + [temp_out]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=600,
                                  env={**os.environ, 'NODE_OPTIONS': '--max-old-space-size=3072'})
            if result.returncode != 0:
                print(f"  Batch merge {i} failed: {result.stderr[:200]}")
                return False
            temp_merges.append(temp_out)
            print(f"  Batch {i//batch_size}: merged {len(batch)} chunks -> {os.path.getsize(temp_out)/1024/1024:.1f} MB")
        
        # Final merge of batches
        if len(temp_merges) == 1:
            shutil.move(temp_merges[0], output_path)
        else:
            cmd = ['npx', '--yes', '@gltf-transform/cli', 'merge'] + temp_merges + [output_path]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=600,
                                  env={**os.environ, 'NODE_OPTIONS': '--max-old-space-size=3072'})
            if result.returncode != 0:
                print(f"  Final merge failed: {result.stderr[:300]}")
                return False
        return True

def process_file(input_path, output_path, max_nodes=50):
    """Full pipeline: split -> compress -> merge."""
    name = os.path.basename(input_path)
    size_mb = os.path.getsize(input_path) / 1024 / 1024
    print(f"\n{'='*60}")
    print(f"Processing: {name} ({size_mb:.1f} MB)")
    print(f"{'='*60}")
    
    work_dir = tempfile.mkdtemp(prefix=f"draco_{name}_")
    split_dir = os.path.join(work_dir, "split")
    compressed_dir = os.path.join(work_dir, "compressed")
    os.makedirs(split_dir)
    os.makedirs(compressed_dir)
    
    try:
        # Step 1: Split
        print("\n[1/3] Splitting into chunks...")
        chunk_files = split_glb_by_nodes(input_path, split_dir, max_nodes)
        if not chunk_files:
            print("  Split failed!")
            return False
        
        # Step 2: Compress each chunk
        print(f"\n[2/3] Compressing {len(chunk_files)} chunks with Draco (lossless)...")
        compressed_files = []
        for i, chunk_path in enumerate(chunk_files):
            chunk_name = os.path.basename(chunk_path)
            comp_path = os.path.join(compressed_dir, chunk_name)
            orig_size = os.path.getsize(chunk_path) / 1024 / 1024
            print(f"  Compressing chunk {i+1}/{len(chunk_files)} ({orig_size:.1f} MB)...", end=" ", flush=True)
            success = compress_chunk_draco(chunk_path, comp_path)
            if os.path.exists(comp_path):
                new_size = os.path.getsize(comp_path) / 1024 / 1024
                ratio = (1 - new_size / orig_size) * 100 if orig_size > 0 else 0
                print(f"-> {new_size:.1f} MB ({ratio:.0f}% reduction)" + (" [DRACO]" if success else " [COPY]"))
            compressed_files.append(comp_path)
        
        # Step 3: Merge
        print(f"\n[3/3] Merging {len(compressed_files)} compressed chunks...")
        success = merge_glbs(compressed_files, output_path)
        if success and os.path.exists(output_path):
            final_size = os.path.getsize(output_path) / 1024 / 1024
            ratio = (1 - final_size / size_mb) * 100
            print(f"\n  RESULT: {size_mb:.1f} MB -> {final_size:.1f} MB ({ratio:.1f}% reduction)")
            return True
        else:
            print("\n  Merge failed!")
            return False
    finally:
        # Cleanup
        shutil.rmtree(work_dir, ignore_errors=True)

if __name__ == "__main__":
    files = [
        ("/home/ubuntu/glb-draco-large/electrical.glb", "/home/ubuntu/glb-draco-large/electrical-draco.glb"),
        ("/home/ubuntu/glb-draco-large/hydraulic.glb", "/home/ubuntu/glb-draco-large/hydraulic-draco.glb"),
    ]
    
    for input_path, output_path in files:
        if not os.path.exists(input_path):
            print(f"SKIP: {input_path} not found")
            continue
        success = process_file(input_path, output_path, max_nodes=30)
        if success:
            print(f"SUCCESS: {output_path}")
        else:
            print(f"FAILED: {input_path}")
