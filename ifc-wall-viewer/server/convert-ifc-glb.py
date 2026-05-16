#!/usr/bin/env python3
"""
Fast IFC → GLB conversion using IfcOpenShell.
Uses lower mesh resolution for faster processing of large files.
Still preserves all geometry elements (pipes, elbows, valves, etc.)
but with fewer triangles per curved surface.

Usage: python3 convert-ifc-glb-fast.py <input.ifc> <output.glb>
"""
import sys
import os
import struct
import json
import numpy as np

def convert_ifc_to_glb(ifc_path: str, glb_path: str):
    import ifcopenshell
    import ifcopenshell.geom
    import ifcopenshell.ifcopenshell_wrapper as wrapper

    file_size = os.path.getsize(ifc_path) / 1024 / 1024
    print(f"Loading IFC: {ifc_path} ({file_size:.1f}MB)")
    
    ifc_file = ifcopenshell.open(ifc_path)
    
    settings = ifcopenshell.geom.settings()
    # Balanced detail - faster than 0.001 but still good quality
    settings.set("mesher-linear-deflection", 0.01)   # 10x faster than 0.001
    settings.set("mesher-angular-deflection", 15.0)   # Degrees, less segments for arcs
    settings.set("weld-vertices", True)
    settings.set("use-world-coords", True)
    settings.set("iterator-output", wrapper.TRIANGULATED)
    settings.set("apply-default-materials", True)
    settings.set("generate-uvs", False)
    
    iterator = ifcopenshell.geom.iterator(settings, ifc_file)
    
    # Pre-allocate lists
    all_positions = []
    all_normals = []
    all_indices = []
    all_colors = []
    
    mesh_count = 0
    total_vertices = 0
    total_triangles = 0
    current_vertex_offset = 0
    
    if not iterator.initialize():
        print("ERROR: Could not initialize geometry iterator!")
        sys.exit(1)
    
    while True:
        shape = iterator.get()
        geometry = shape.geometry
        
        verts = geometry.verts
        faces = geometry.faces
        normals_data = geometry.normals
        materials = geometry.materials
        
        if len(verts) == 0 or len(faces) == 0:
            if not iterator.next():
                break
            continue
        
        vertices = np.array(verts, dtype=np.float32).reshape(-1, 3)
        triangles = np.array(faces, dtype=np.uint32).reshape(-1, 3)
        
        if len(normals_data) > 0:
            norms = np.array(normals_data, dtype=np.float32).reshape(-1, 3)
        else:
            norms = np.zeros_like(vertices)
        
        # Get color
        color = [0.7, 0.7, 0.7, 1.0]
        if materials:
            try:
                mat = materials[0]
                d = mat.diffuse
                if hasattr(d, 'r'):
                    color = [d.r(), d.g(), d.b(), 1.0 - (mat.transparency if mat.transparency else 0)]
                elif hasattr(d, '__len__') and len(d) >= 3:
                    color = [d[0], d[1], d[2], 1.0 - (mat.transparency if mat.transparency else 0)]
            except:
                pass
        
        offset_triangles = triangles + current_vertex_offset
        
        all_positions.append(vertices)
        all_normals.append(norms)
        all_indices.append(offset_triangles)
        
        vc = np.tile(np.array(color, dtype=np.float32), (len(vertices), 1))
        all_colors.append(vc)
        
        current_vertex_offset += len(vertices)
        total_vertices += len(vertices)
        total_triangles += len(triangles)
        mesh_count += 1
        
        if mesh_count % 2000 == 0:
            print(f"  {mesh_count} meshes, {total_vertices:,} verts, {total_triangles:,} tris...")
        
        if not iterator.next():
            break
    
    print(f"  Total: {mesh_count} meshes, {total_vertices:,} vertices, {total_triangles:,} triangles")
    
    if mesh_count == 0:
        print("ERROR: No geometry extracted!")
        sys.exit(1)
    
    print("  Combining geometry...")
    positions = np.concatenate(all_positions, axis=0)
    normals = np.concatenate(all_normals, axis=0)
    indices = np.concatenate(all_indices, axis=0).flatten()
    colors = np.concatenate(all_colors, axis=0)
    
    # Free intermediate arrays
    del all_positions, all_normals, all_indices, all_colors
    
    print("  Building GLB...")
    write_glb(glb_path, positions, normals, indices, colors)
    
    size_mb = os.path.getsize(glb_path) / 1024 / 1024
    print(f"  ✓ GLB: {size_mb:.1f}MB, {mesh_count} meshes, {total_vertices:,} verts")
    return mesh_count, total_vertices


def write_glb(path, positions, normals, indices, colors):
    pos_bytes = positions.astype(np.float32).tobytes()
    norm_bytes = normals.astype(np.float32).tobytes()
    idx_bytes = indices.astype(np.uint32).tobytes()
    color_u8 = (colors * 255).clip(0, 255).astype(np.uint8)
    color_bytes = color_u8.tobytes()
    
    pos_length = len(pos_bytes)
    norm_offset = pos_length
    norm_length = len(norm_bytes)
    idx_offset = norm_offset + norm_length
    idx_length = len(idx_bytes)
    color_offset = idx_offset + idx_length
    color_length = len(color_bytes)
    
    total_buf = pos_length + norm_length + idx_length + color_length
    padding = (4 - (total_buf % 4)) % 4
    total_buf_padded = total_buf + padding
    
    pos_min = positions.min(axis=0).tolist()
    pos_max = positions.max(axis=0).tolist()
    num_verts = len(positions)
    num_idx = len(indices)
    
    gltf = {
        "asset": {"version": "2.0", "generator": "ifc-wall-viewer"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "COLOR_0": 3}, "indices": 2, "mode": 4, "material": 0}]}],
        "materials": [{"pbrMetallicRoughness": {"metallicFactor": 0.0, "roughnessFactor": 0.8}, "doubleSided": True}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": num_verts, "type": "VEC3", "min": pos_min, "max": pos_max},
            {"bufferView": 1, "componentType": 5126, "count": num_verts, "type": "VEC3"},
            {"bufferView": 2, "componentType": 5125, "count": num_idx, "type": "SCALAR"},
            {"bufferView": 3, "componentType": 5121, "count": num_verts, "type": "VEC4", "normalized": True},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": pos_length, "target": 34962},
            {"buffer": 0, "byteOffset": norm_offset, "byteLength": norm_length, "target": 34962},
            {"buffer": 0, "byteOffset": idx_offset, "byteLength": idx_length, "target": 34963},
            {"buffer": 0, "byteOffset": color_offset, "byteLength": color_length, "target": 34962},
        ],
        "buffers": [{"byteLength": total_buf_padded}],
    }
    
    json_str = json.dumps(gltf, separators=(',', ':'))
    json_bytes = json_str.encode('utf-8')
    json_pad = (4 - (len(json_bytes) % 4)) % 4
    json_bytes_padded = json_bytes + b' ' * json_pad
    
    glb_length = 12 + 8 + len(json_bytes_padded) + 8 + total_buf_padded
    
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, glb_length))
        f.write(struct.pack('<II', len(json_bytes_padded), 0x4E4F534A))
        f.write(json_bytes_padded)
        f.write(struct.pack('<II', total_buf_padded, 0x004E4942))
        f.write(pos_bytes)
        f.write(norm_bytes)
        f.write(idx_bytes)
        f.write(color_bytes)
        f.write(b'\x00' * padding)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python3 convert-ifc-glb-fast.py <input.ifc> <output.glb>")
        sys.exit(1)
    os.makedirs(os.path.dirname(sys.argv[2]) or '.', exist_ok=True)
    convert_ifc_to_glb(sys.argv[1], sys.argv[2])
