#!/usr/bin/env python3
"""
Phase 1: Split a large GLB into ~10 chunks on disk.
Exits after splitting to free all memory for Phase 2 (Draco compression).
Usage: python3 split-glb.py <input.glb> <output_dir> [nodes_per_chunk]
"""
import sys
import os
import json
import struct
import gc

def main():
    input_path = sys.argv[1]
    output_dir = sys.argv[2]
    nodes_per_chunk = int(sys.argv[3]) if len(sys.argv) > 3 else 2000
    
    os.makedirs(output_dir, exist_ok=True)
    size_mb = os.path.getsize(input_path) / 1024 / 1024
    print(f"Splitting: {input_path} ({size_mb:.1f} MB), {nodes_per_chunk} nodes/chunk")
    
    # Read GLB header + JSON
    with open(input_path, 'rb') as f:
        magic, version, length = struct.unpack('<III', f.read(12))
        json_length, json_type = struct.unpack('<II', f.read(8))
        json_data = f.read(json_length).decode('utf-8')
        gltf = json.loads(json_data)
        bin_length, bin_type = struct.unpack('<II', f.read(8))
        bin_offset = 12 + 8 + json_length + 8
    
    nodes = gltf.get('nodes', [])
    meshes = gltf.get('meshes', [])
    accessors = gltf.get('accessors', [])
    buffer_views = gltf.get('bufferViews', [])
    materials = gltf.get('materials', [])
    
    mesh_node_indices = [i for i, n in enumerate(nodes) if 'mesh' in n]
    print(f"  {len(nodes)} nodes, {len(mesh_node_indices)} mesh nodes, {len(meshes)} meshes")
    
    # Group into chunks
    chunks = []
    for i in range(0, len(mesh_node_indices), nodes_per_chunk):
        chunks.append(mesh_node_indices[i:i+nodes_per_chunk])
    print(f"  {len(chunks)} chunks")
    
    # Read binary data
    with open(input_path, 'rb') as f:
        f.seek(bin_offset)
        bin_data = f.read(bin_length)
    print(f"  Binary loaded: {len(bin_data)/1024/1024:.1f} MB")
    
    # Write each chunk
    for ci, chunk_indices in enumerate(chunks):
        needed_meshes = set()
        needed_accessors = set()
        needed_buffer_views = set()
        needed_materials = set()
        
        for ni in chunk_indices:
            node = nodes[ni]
            mi = node['mesh']
            needed_meshes.add(mi)
            mesh = meshes[mi]
            for prim in mesh.get('primitives', []):
                if 'material' in prim: needed_materials.add(prim['material'])
                if 'indices' in prim: needed_accessors.add(prim['indices'])
                for acc in prim.get('attributes', {}).values():
                    needed_accessors.add(acc)
        
        for ai in needed_accessors:
            a = accessors[ai]
            if 'bufferView' in a: needed_buffer_views.add(a['bufferView'])
        
        sm = sorted(needed_meshes)
        sa = sorted(needed_accessors)
        sb = sorted(needed_buffer_views)
        smat = sorted(needed_materials)
        mr = {o: n for n, o in enumerate(sm)}
        ar = {o: n for n, o in enumerate(sa)}
        br = {o: n for n, o in enumerate(sb)}
        matr = {o: n for n, o in enumerate(smat)}
        
        new_bin = bytearray()
        bv_offsets = {}
        for bvi in sb:
            bv = buffer_views[bvi]
            off = bv.get('byteOffset', 0)
            ln = bv['byteLength']
            while len(new_bin) % 4 != 0: new_bin.append(0)
            bv_offsets[bvi] = len(new_bin)
            new_bin.extend(bin_data[off:off+ln])
        while len(new_bin) % 4 != 0: new_bin.append(0)
        
        g = {
            "asset": gltf.get("asset", {"version": "2.0"}),
            "scene": 0,
            "scenes": [{"nodes": list(range(len(chunk_indices)))}],
            "nodes": [],
            "meshes": [],
            "accessors": [],
            "bufferViews": [],
            "buffers": [{"byteLength": len(new_bin)}],
        }
        if smat:
            g["materials"] = [materials[i] for i in smat]
        
        for ni in chunk_indices:
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
        
        # Write GLB
        json_str = json.dumps(g, separators=(',', ':'))
        json_bytes = json_str.encode('utf-8')
        while len(json_bytes) % 4 != 0: json_bytes += b' '
        
        chunk_path = os.path.join(output_dir, f"chunk_{ci:03d}.glb")
        with open(chunk_path, 'wb') as f:
            total = 12 + 8 + len(json_bytes) + 8 + len(new_bin)
            f.write(struct.pack('<III', 0x46546C67, 2, total))
            f.write(struct.pack('<II', len(json_bytes), 0x4E4F534A))
            f.write(json_bytes)
            f.write(struct.pack('<II', len(new_bin), 0x004E4942))
            f.write(new_bin)
        
        cs = os.path.getsize(chunk_path) / 1024 / 1024
        print(f"  Chunk {ci}: {len(chunk_indices)} nodes, {cs:.1f} MB")
        del new_bin, g
    
    del bin_data
    gc.collect()
    print(f"DONE: {len(chunks)} chunks written to {output_dir}")

if __name__ == "__main__":
    main()
