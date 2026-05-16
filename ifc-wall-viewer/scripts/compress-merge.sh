#!/bin/bash
# Phase 2: Compress each chunk with Draco and merge into final GLB
# Usage: ./compress-merge.sh <chunks_dir> <output.glb>
set -e

CHUNKS_DIR="$1"
OUTPUT="$2"
COMP_DIR="${CHUNKS_DIR}/compressed"
mkdir -p "$COMP_DIR"

# Count chunks
TOTAL=$(ls "$CHUNKS_DIR"/chunk_*.glb 2>/dev/null | wc -l)
echo "Compressing $TOTAL chunks with Draco..."

# Compress each chunk sequentially (to avoid OOM)
COUNT=0
for chunk in "$CHUNKS_DIR"/chunk_*.glb; do
    COUNT=$((COUNT + 1))
    base=$(basename "$chunk")
    comp="$COMP_DIR/$base"
    orig_size=$(stat -c%s "$chunk" 2>/dev/null || stat -f%z "$chunk")
    
    # Compress with Draco (edgebreaker = lossless topology)
    if NODE_OPTIONS="--max-old-space-size=3072" npx --yes @gltf-transform/cli draco "$chunk" "$comp" --method edgebreaker 2>/dev/null; then
        comp_size=$(stat -c%s "$comp" 2>/dev/null || stat -f%z "$comp")
        ratio=$(echo "scale=0; (1 - $comp_size / $orig_size) * 100" | bc)
        echo "  [$COUNT/$TOTAL] $(echo "scale=1; $orig_size/1048576" | bc)MB -> $(echo "scale=1; $comp_size/1048576" | bc)MB (${ratio}%)"
    else
        cp "$chunk" "$comp"
        echo "  [$COUNT/$TOTAL] COPY (Draco failed)"
    fi
    
    # Remove original chunk to save disk
    rm -f "$chunk"
done

echo ""
echo "Merging $TOTAL compressed chunks..."

# Merge in batches of 5 to avoid OOM
LEVEL=0
CURRENT_DIR="$COMP_DIR"

while true; do
    files=("$CURRENT_DIR"/*.glb)
    count=${#files[@]}
    
    if [ "$count" -le 1 ]; then
        # Single file - just move it
        cp "${files[0]}" "$OUTPUT"
        break
    fi
    
    if [ "$count" -le 5 ]; then
        # Small enough to merge directly
        NODE_OPTIONS="--max-old-space-size=3072" npx --yes @gltf-transform/cli merge "${files[@]}" "$OUTPUT" 2>/dev/null
        break
    fi
    
    # Merge in batches
    NEXT_DIR="${CHUNKS_DIR}/merge_L${LEVEL}"
    mkdir -p "$NEXT_DIR"
    BATCH=0
    
    for ((i=0; i<count; i+=5)); do
        batch_files=("${files[@]:$i:5}")
        batch_out="$NEXT_DIR/batch_${BATCH}.glb"
        
        if [ ${#batch_files[@]} -eq 1 ]; then
            cp "${batch_files[0]}" "$batch_out"
        else
            NODE_OPTIONS="--max-old-space-size=3072" npx --yes @gltf-transform/cli merge "${batch_files[@]}" "$batch_out" 2>/dev/null
        fi
        
        size=$(echo "scale=1; $(stat -c%s "$batch_out" 2>/dev/null || stat -f%z "$batch_out")/1048576" | bc)
        echo "  L${LEVEL} batch ${BATCH}: ${#batch_files[@]} files -> ${size}MB"
        BATCH=$((BATCH + 1))
    done
    
    # Clean previous level
    rm -rf "$CURRENT_DIR"
    CURRENT_DIR="$NEXT_DIR"
    LEVEL=$((LEVEL + 1))
done

if [ -f "$OUTPUT" ]; then
    final_size=$(echo "scale=1; $(stat -c%s "$OUTPUT" 2>/dev/null || stat -f%z "$OUTPUT")/1048576" | bc)
    echo ""
    echo "SUCCESS: $OUTPUT (${final_size}MB)"
else
    echo "FAILED: Output not created"
    exit 1
fi
