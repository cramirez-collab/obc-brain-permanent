"""
Analyze the bounding box and orientation of each GLB model to detect
which ones are rotated 90 degrees and need correction.
Downloads a small portion of each file to read the scene graph.
"""
import json
import struct
import sys
import os
import subprocess
import tempfile

# We'll use gltf-transform to inspect each file
# First get the file URLs from the database

def get_file_info():
    """Get file URLs from the running server"""
    import urllib.request
    
    # Query the project files
    url = "http://localhost:3000/api/trpc/project.getById?batch=1&input=%7B%220%22%3A%7B%22id%22%3A60001%7D%7D"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode())
    
    result = data[0]["result"]["data"]
    files = result["files"]
    return files

def analyze_glb_with_gltf_transform(url, name):
    """Use gltf-transform inspect to get scene info"""
    # Download the file first (just the header portion for small files, full for draco)
    tmpdir = tempfile.mkdtemp()
    tmpfile = os.path.join(tmpdir, f"{name}.glb")
    
    # For analysis we need the full file - but we can use the proxy URL
    proxy_url = f"http://localhost:3000/api/proxy-glb?url={url}"
    
    print(f"\n{'='*60}")
    print(f"Analyzing: {name}")
    print(f"URL: {url[:80]}...")
    
    # Download with curl (handles gzip)
    result = subprocess.run(
        ["curl", "-sL", "-o", tmpfile, "--max-time", "120", proxy_url],
        capture_output=True, text=True, timeout=130
    )
    
    if not os.path.exists(tmpfile) or os.path.getsize(tmpfile) < 1000:
        print(f"  SKIP: Could not download (size={os.path.getsize(tmpfile) if os.path.exists(tmpfile) else 0})")
        return None
    
    size_mb = os.path.getsize(tmpfile) / 1024 / 1024
    print(f"  Downloaded: {size_mb:.1f} MB")
    
    # Use gltf-transform inspect
    result = subprocess.run(
        ["npx", "--yes", "@gltf-transform/cli", "inspect", tmpfile, "--format", "json"],
        capture_output=True, text=True, timeout=120,
        cwd="/home/ubuntu/ifc-wall-viewer"
    )
    
    if result.returncode != 0:
        print(f"  ERROR inspecting: {result.stderr[:200]}")
        # Try to at least read the GLB header
        try:
            with open(tmpfile, "rb") as f:
                magic = f.read(4)
                version = struct.unpack("<I", f.read(4))[0]
                length = struct.unpack("<I", f.read(4))[0]
                print(f"  GLB header: magic={magic}, version={version}, length={length}")
        except:
            pass
        # Clean up
        os.remove(tmpfile)
        os.rmdir(tmpdir)
        return None
    
    try:
        info = json.loads(result.stdout)
    except:
        print(f"  Could not parse inspect output")
        os.remove(tmpfile)
        os.rmdir(tmpdir)
        return None
    
    # Extract scene info
    scenes = info.get("scenes", {})
    meshes = info.get("meshes", {})
    nodes = info.get("nodes", {})
    
    print(f"  Scenes: {scenes.get('properties', [{}])[0].get('name', 'unnamed') if scenes.get('properties') else 'N/A'}")
    print(f"  Meshes: {meshes.get('count', 'N/A')}")
    print(f"  Nodes: {len(nodes.get('properties', []))}")
    
    # Now get bounding box using gltf-transform
    # Use a simple node.js script to compute bounding box
    bbox_script = os.path.join(tmpdir, "bbox.mjs")
    with open(bbox_script, "w") as f:
        f.write(f"""
import {{ NodeIO }} from '@gltf-transform/core';
import {{ KHRDracoMeshCompression }} from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import {{ getBounds }} from '@gltf-transform/functions';
import fs from 'fs';

const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression])
  .registerDependencies({{
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  }});

const doc = await io.read('{tmpfile}');
const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];

if (!scene) {{
  console.log(JSON.stringify({{ error: 'No scene found' }}));
  process.exit(0);
}}

const bounds = getBounds(scene);
const rootNodes = scene.listChildren();

// Check root node transforms
const transforms = [];
for (const node of rootNodes.slice(0, 10)) {{
  transforms.push({{
    name: node.getName(),
    translation: node.getTranslation(),
    rotation: node.getRotation(),
    scale: node.getScale(),
  }});
}}

console.log(JSON.stringify({{
  bounds: {{
    min: bounds.min,
    max: bounds.max,
    size: [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ],
    center: [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ],
  }},
  rootTransforms: transforms,
}}, null, 2));
""")
    
    bbox_result = subprocess.run(
        ["node", "--max-old-space-size=2048", "--import", "tsx", bbox_script],
        capture_output=True, text=True, timeout=120,
        cwd="/home/ubuntu/ifc-wall-viewer"
    )
    
    if bbox_result.returncode != 0:
        print(f"  ERROR getting bounds: {bbox_result.stderr[:300]}")
        os.remove(tmpfile)
        os.remove(bbox_script)
        os.rmdir(tmpdir)
        return None
    
    try:
        bbox_info = json.loads(bbox_result.stdout)
        bounds = bbox_info["bounds"]
        print(f"  Bounding Box:")
        print(f"    Min: [{bounds['min'][0]:.2f}, {bounds['min'][1]:.2f}, {bounds['min'][2]:.2f}]")
        print(f"    Max: [{bounds['max'][0]:.2f}, {bounds['max'][1]:.2f}, {bounds['max'][2]:.2f}]")
        print(f"    Size: [{bounds['size'][0]:.2f}, {bounds['size'][1]:.2f}, {bounds['size'][2]:.2f}]")
        print(f"    Center: [{bounds['center'][0]:.2f}, {bounds['center'][1]:.2f}, {bounds['center'][2]:.2f}]")
        
        # Detect orientation issues
        # In a building model, Y should be the vertical axis (height)
        # If Z is much larger than Y, the model might be rotated
        sx, sy, sz = bounds['size']
        
        # Check if model appears to be lying on its side
        if sz > sy * 2 and sz > 5:
            print(f"  ⚠️  POSSIBLE ROTATION: Z-extent ({sz:.1f}) >> Y-extent ({sy:.1f})")
            print(f"     Model may need -90° rotation around X axis")
        elif sy > sz * 2 and sy > 5:
            print(f"  ✅ Model appears correctly oriented (Y-up: {sy:.1f})")
        else:
            print(f"  ℹ️  Ambiguous orientation (Y={sy:.1f}, Z={sz:.1f})")
        
        # Print root transforms
        if bbox_info.get("rootTransforms"):
            print(f"  Root node transforms (first 5):")
            for t in bbox_info["rootTransforms"][:5]:
                r = t["rotation"]
                print(f"    {t['name'][:30]:30s} rot=[{r[0]:.4f}, {r[1]:.4f}, {r[2]:.4f}, {r[3]:.4f}] pos={t['translation']}")
        
        # Clean up
        os.remove(tmpfile)
        os.remove(bbox_script)
        os.rmdir(tmpdir)
        return bbox_info
        
    except Exception as e:
        print(f"  ERROR parsing bounds: {e}")
        print(f"  stdout: {bbox_result.stdout[:500]}")
    
    # Clean up
    try:
        os.remove(tmpfile)
        os.remove(bbox_script)
        os.rmdir(tmpdir)
    except:
        pass
    return None

def main():
    files = get_file_info()
    
    results = {}
    
    # Sort by file size (smallest first for faster analysis)
    sorted_files = sorted(files, key=lambda f: f.get("fileSize", 0) or 0)
    
    for f in sorted_files:
        name = f["specialty"]
        file_key = f["fileKey"]
        file_size = f.get("fileSize", 0) or 0
        size_mb = file_size / 1024 / 1024
        
        # Skip very large files for now (electrical/hydraulic > 150MB)
        if size_mb > 200:
            print(f"\n{'='*60}")
            print(f"SKIPPING {name} ({size_mb:.0f}MB) - too large for analysis")
            continue
        
        # Get the URL via the API
        url = f.get("url", "")
        if not url:
            # Need to call getFileUrl
            import urllib.request
            get_url = f"http://localhost:3000/api/trpc/project.getFileUrl?batch=1&input=%7B%220%22%3A%7B%22fileKey%22%3A%22{file_key}%22%7D%7D"
            try:
                req = urllib.request.Request(get_url)
                with urllib.request.urlopen(req) as resp:
                    data = json.loads(resp.read().decode())
                url = data[0]["result"]["data"]["url"]
            except Exception as e:
                print(f"  Could not get URL for {name}: {e}")
                continue
        
        info = analyze_glb_with_gltf_transform(url, name)
        if info:
            results[name] = info
    
    # Summary
    print(f"\n{'='*60}")
    print("SUMMARY - Alignment Analysis")
    print(f"{'='*60}")
    
    for name, info in results.items():
        b = info["bounds"]
        print(f"\n{name}:")
        print(f"  Center: [{b['center'][0]:.2f}, {b['center'][1]:.2f}, {b['center'][2]:.2f}]")
        print(f"  Size:   [{b['size'][0]:.2f}, {b['size'][1]:.2f}, {b['size'][2]:.2f}]")

if __name__ == "__main__":
    main()
