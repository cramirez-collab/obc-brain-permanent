/**
 * Precise floor detection by combining structure + gas model data.
 * The gas model has the most consistent floor spacing (3.3-3.4m) for typical floors.
 * The structure model provides basement and ground level data.
 * 
 * Strategy: Use the gas model's regular spacing to establish typical floors,
 * then use structure for basements and ground level.
 */

// From the analysis:
// Structure Y range: -13.76m to 79.93m
// Architecture Y range: -11.10m to 79.30m
// Gas Y range: -11.10m to 80.26m

// Gas model floors (most reliable for typical floors):
const gasFloors = [0.0, 23.1, 29.8, 33.2, 36.5, 39.9, 43.2, 46.6, 50.0, 53.3, 56.7, 63.4, 66.8, 70.1, 73.5];

// Structure model floors (reliable for basements):
const structFloors = [-8.0, -4.9, -0.1, 3.0, 5.5, 12.9, 16.3, 19.6, 22.9, 26.4, 33.1, 39.8, 43.2, 49.9, 52.5, 56.5, 59.3, 62.5, 66.7, 70.0, 79.9];

// Merge and deduplicate (within 1m tolerance)
const allFloors = [...structFloors, ...gasFloors];
allFloors.sort((a, b) => a - b);

const merged = [];
for (const y of allFloors) {
  if (merged.length === 0 || Math.abs(y - merged[merged.length - 1]) > 1.0) {
    merged.push(y);
  } else {
    // Average the close values
    merged[merged.length - 1] = (merged[merged.length - 1] + y) / 2;
  }
}

console.log("MERGED FLOOR LEVELS:");
console.log("====================\n");

// Assign labels
// Building has: basements below 0, PB at 0, then numbered floors above
let basementCount = 0;
let floorCount = 0;
const labeled = [];

for (let i = 0; i < merged.length; i++) {
  const y = merged[i];
  const spacing = i > 0 ? (y - merged[i-1]).toFixed(2) : '-';
  
  let label, short;
  if (y < -1) {
    basementCount++;
    // Count from bottom
  } else if (Math.abs(y) <= 1) {
    label = "Planta Baja";
    short = "PB";
  } else {
    floorCount++;
  }
  
  labeled.push({ y: Math.round(y * 100) / 100, spacing, index: i });
}

// Re-label basements from bottom
const basements = labeled.filter(f => f.y < -1);
basements.forEach((f, i) => {
  f.label = `Sótano ${basements.length - i}`;
  f.short = `S${basements.length - i}`;
});

// Label PB
const pb = labeled.find(f => Math.abs(f.y) <= 1);
if (pb) { pb.label = "Planta Baja"; pb.short = "PB"; }

// Label floors above PB
const above = labeled.filter(f => f.y > 1);
above.forEach((f, i) => {
  f.label = `Nivel ${i + 1}`;
  f.short = `N${i + 1}`;
});

// Print all
console.log(`${'Label'.padEnd(20)} ${'Short'.padEnd(8)} ${'Y (m)'.padStart(10)} ${'Spacing'.padStart(10)}`);
console.log('-'.repeat(52));
for (const f of labeled) {
  console.log(`${(f.label || '???').padEnd(20)} ${(f.short || '?').padEnd(8)} ${f.y.toFixed(2).padStart(10)} ${f.spacing.toString().padStart(10)}`);
}

// Output as JavaScript array for FLOOR_LEVELS
console.log("\n\n// FLOOR_LEVELS for ProjectViewer.tsx:");
console.log("const FLOOR_LEVELS = [");
for (const f of labeled) {
  console.log(`  { label: "${f.label}", short: "${f.short}", y: ${f.y.toFixed(1)} },`);
}
console.log("];");

// Also output for ALL_FLOORS (floor signs)
console.log("\n// ALL_FLOORS for floor signs:");
console.log("const ALL_FLOORS = [");
for (const f of labeled) {
  console.log(`  { label: "${f.short}", y: ${f.y.toFixed(1)} },`);
}
console.log("];");
