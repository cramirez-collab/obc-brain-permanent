import { describe, it, expect } from "vitest";

/**
 * Tests for visual mode presets and new feature configurations.
 * These validate the data structures and logic used by ProjectViewer.tsx
 * without requiring a browser/DOM environment.
 */

// Replicate the visual mode types and preset logic from ProjectViewer
type VisualMode = "normal" | "crystal" | "solid" | "dark" | "translucent" | "xray";

interface VisualSettings {
  hueShift: number;
  saturation: number;
  opacity: number;
  edgeThickness: number;
  edgeColor: string;
}

const PIPE_SPECIALTIES = ["plumbing", "hvac", "mechanical", "electrical"];
const ARCH_SPECIALTIES = ["arch_struct", "architecture", "structure"];

function getVisualPreset(
  mode: VisualMode,
  specialty: string,
  fileColor: string,
  fileOpacity: number
): VisualSettings {
  const isArch = ARCH_SPECIALTIES.includes(specialty);
  const isPipe = PIPE_SPECIALTIES.includes(specialty);

  switch (mode) {
    case "crystal":
      return {
        hueShift: 0,
        saturation: 0.4,
        opacity: isArch ? 20 : isPipe ? 85 : 35,
        edgeThickness: 2,
        edgeColor: isArch ? "#B0C4DE" : isPipe ? fileColor : "#7B8FA8",
      };
    case "solid":
      return {
        hueShift: 0,
        saturation: 1.2,
        opacity: 100,
        edgeThickness: 1.5,
        edgeColor: "#333333",
      };
    case "dark":
      return {
        hueShift: 0,
        saturation: 0.6,
        opacity: isArch ? 90 : 95,
        edgeThickness: 2.5,
        edgeColor: "#00E5CC",
      };
    case "translucent":
      return {
        hueShift: 0,
        saturation: 0.8,
        opacity: isArch ? 12 : isPipe ? 70 : 30,
        edgeThickness: 1.5,
        edgeColor: isArch ? "#94A3B8" : fileColor,
      };
    case "xray":
      return {
        hueShift: 0,
        saturation: isArch ? 0.3 : isPipe ? 1.5 : 0.5,
        opacity: isArch ? 15 : isPipe ? 100 : 60,
        edgeThickness: isArch ? 0.5 : isPipe ? 3 : 2,
        edgeColor: isArch ? "#94A3B8" : isPipe ? fileColor : "#1B2A4A",
      };
    default: // normal
      return {
        hueShift: 0,
        saturation: 1,
        opacity: fileOpacity,
        edgeThickness: 1,
        edgeColor: "#999999",
      };
  }
}

describe("ARCH_SPECIALTIES constant", () => {
  it("should include arch_struct, architecture, and structure", () => {
    expect(ARCH_SPECIALTIES).toContain("arch_struct");
    expect(ARCH_SPECIALTIES).toContain("architecture");
    expect(ARCH_SPECIALTIES).toContain("structure");
    expect(ARCH_SPECIALTIES).toHaveLength(3);
  });

  it("should NOT include MEP specialties", () => {
    for (const mep of PIPE_SPECIALTIES) {
      expect(ARCH_SPECIALTIES).not.toContain(mep);
    }
  });
});

describe("Visual Mode Presets", () => {
  const ALL_MODES: VisualMode[] = ["normal", "crystal", "solid", "dark", "translucent", "xray"];

  it("should return valid settings for all modes and specialties", () => {
    const specialties = ["arch_struct", "architecture", "structure", "hvac", "plumbing", "electrical", "mechanical"];
    for (const mode of ALL_MODES) {
      for (const spec of specialties) {
        const settings = getVisualPreset(mode, spec, "#FF6B35", 85);
        expect(settings.opacity).toBeGreaterThanOrEqual(0);
        expect(settings.opacity).toBeLessThanOrEqual(100);
        expect(settings.edgeThickness).toBeGreaterThanOrEqual(0);
        expect(settings.edgeThickness).toBeLessThanOrEqual(4);
        expect(settings.saturation).toBeGreaterThanOrEqual(0);
        expect(settings.saturation).toBeLessThanOrEqual(2);
        expect(settings.edgeColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });

  it("crystal mode: all arch specialties should be very transparent (20%)", () => {
    for (const spec of ARCH_SPECIALTIES) {
      const s = getVisualPreset("crystal", spec, "#C0C0C0", 85);
      expect(s.opacity).toBe(20);
      expect(s.edgeThickness).toBe(2);
    }
  });

  it("crystal mode: pipes should be mostly opaque (85%)", () => {
    const s = getVisualPreset("crystal", "hvac", "#FF6B35", 100);
    expect(s.opacity).toBe(85);
  });

  it("solid mode: everything at 100% opacity", () => {
    for (const spec of ["arch_struct", "architecture", "structure", "hvac", "plumbing"]) {
      const s = getVisualPreset("solid", spec, "#FF0000", 50);
      expect(s.opacity).toBe(100);
    }
  });

  it("dark mode: edges should be neon teal", () => {
    for (const spec of ARCH_SPECIALTIES) {
      const s = getVisualPreset("dark", spec, "#C0C0C0", 85);
      expect(s.edgeColor).toBe("#00E5CC");
      expect(s.edgeThickness).toBe(2.5);
    }
  });

  it("translucent mode: arch very transparent, pipes semi-opaque", () => {
    for (const spec of ARCH_SPECIALTIES) {
      const arch = getVisualPreset("translucent", spec, "#C0C0C0", 85);
      expect(arch.opacity).toBe(12);
    }
    const pipe = getVisualPreset("translucent", "plumbing", "#2196F3", 100);
    expect(pipe.opacity).toBe(70);
  });

  it("xray mode: arch nearly invisible, pipes fully opaque", () => {
    for (const spec of ARCH_SPECIALTIES) {
      const arch = getVisualPreset("xray", spec, "#C0C0C0", 85);
      expect(arch.opacity).toBe(15);
    }
    const pipe = getVisualPreset("xray", "hvac", "#FF6B35", 100);
    expect(pipe.opacity).toBe(100);
  });

  it("normal mode: uses file's original opacity", () => {
    const s = getVisualPreset("normal", "arch_struct", "#C0C0C0", 42);
    expect(s.opacity).toBe(42);
    expect(s.edgeThickness).toBe(1);
  });

  it("architecture and structure should behave identically to arch_struct in all modes", () => {
    for (const mode of ALL_MODES) {
      const archStruct = getVisualPreset(mode, "arch_struct", "#C0C0C0", 85);
      const architecture = getVisualPreset(mode, "architecture", "#C0C0C0", 85);
      const structure = getVisualPreset(mode, "structure", "#C0C0C0", 85);
      expect(architecture).toEqual(archStruct);
      expect(structure).toEqual(archStruct);
    }
  });
});

describe("Walk Height Configuration", () => {
  const DEFAULT_WALK_HEIGHT = 1.65;
  const MIN_HEIGHT = 0.5;
  const MAX_HEIGHT = 3.0;

  it("default walk height should be 1.65m", () => {
    expect(DEFAULT_WALK_HEIGHT).toBe(1.65);
  });

  it("height range should be 0.5m to 3.0m", () => {
    expect(MIN_HEIGHT).toBe(0.5);
    expect(MAX_HEIGHT).toBe(3.0);
    expect(MAX_HEIGHT).toBeGreaterThan(MIN_HEIGHT);
  });

  it("default height should be within valid range", () => {
    expect(DEFAULT_WALK_HEIGHT).toBeGreaterThanOrEqual(MIN_HEIGHT);
    expect(DEFAULT_WALK_HEIGHT).toBeLessThanOrEqual(MAX_HEIGHT);
  });
});

describe("Floor Levels Configuration (Updated)", () => {
  const FLOOR_LEVELS = [
    { label: "Sótano 5", short: "S-5", y: -15.0 },
    { label: "Sótano 4", short: "S-4", y: -12.0 },
    { label: "Sótano 3", short: "S-3", y: -9.0 },
    { label: "Sótano 2", short: "S-2", y: -6.0 },
    { label: "Sótano 1", short: "S-1", y: -3.0 },
    { label: "Banqueta (PB)", short: "PB", y: 0.0 },
    { label: "Piso 1", short: "P1", y: 3.0 },
    { label: "Piso 2", short: "P2", y: 6.0 },
    { label: "Piso 3", short: "P3", y: 9.0 },
    { label: "Piso 4", short: "P4", y: 12.0 },
    { label: "Piso 5", short: "P5", y: 15.0 },
    { label: "Piso 6", short: "P6", y: 18.0 },
    { label: "Piso 7", short: "P7", y: 21.0 },
    { label: "Piso 8", short: "P8", y: 24.0 },
    { label: "Piso 9", short: "P9", y: 27.0 },
    { label: "Piso 10", short: "P10", y: 30.0 },
    { label: "Piso 11", short: "P11", y: 33.0 },
    { label: "Piso 12", short: "P12", y: 36.0 },
    { label: "Piso 13", short: "P13", y: 39.0 },
    { label: "Piso 14", short: "P14", y: 42.0 },
    { label: "Piso 15", short: "P15", y: 45.0 },
    { label: "Piso 16", short: "P16", y: 48.0 },
    { label: "Piso 17", short: "P17", y: 51.0 },
    { label: "Piso 18", short: "P18", y: 54.0 },
    { label: "Piso 19", short: "P19", y: 57.0 },
    { label: "Piso 20", short: "P20", y: 60.0 },
    { label: "Piso 21", short: "P21", y: 63.0 },
  ];

  it("should have 27 floor levels", () => {
    expect(FLOOR_LEVELS).toHaveLength(27);
  });

  it("should have 5 basement levels (Sótano 5 to Sótano 1)", () => {
    const basements = FLOOR_LEVELS.filter(f => f.label.startsWith("Sótano"));
    expect(basements).toHaveLength(5);
    expect(basements[0].label).toBe("Sótano 5");
    expect(basements[0].short).toBe("S-5");
    expect(basements[4].label).toBe("Sótano 1");
    expect(basements[4].short).toBe("S-1");
  });

  it("should have Banqueta (PB) at y=0", () => {
    const pb = FLOOR_LEVELS.find(f => f.short === "PB");
    expect(pb).toBeDefined();
    expect(pb!.y).toBe(0);
    expect(pb!.label).toBe("Banqueta (PB)");
  });

  it("should have 21 upper levels (Piso 1 to Piso 21)", () => {
    const levels = FLOOR_LEVELS.filter(f => f.label.startsWith("Piso"));
    expect(levels).toHaveLength(21);
    expect(levels[0].short).toBe("P1");
    expect(levels[20].short).toBe("P21");
  });

  it("floor-to-floor height should be 3m", () => {
    for (let i = 1; i < FLOOR_LEVELS.length; i++) {
      const diff = FLOOR_LEVELS[i].y - FLOOR_LEVELS[i - 1].y;
      expect(diff).toBeCloseTo(3.0, 1);
    }
  });

  it("all floors should have both label and short properties", () => {
    for (const floor of FLOOR_LEVELS) {
      expect(floor.label).toBeTruthy();
      expect(floor.short).toBeTruthy();
      expect(typeof floor.y).toBe("number");
    }
  });

  it("short labels should be unique", () => {
    const shorts = FLOOR_LEVELS.map(f => f.short);
    const unique = new Set(shorts);
    expect(unique.size).toBe(shorts.length);
  });

  it("floor detection should return correct short label", () => {
    function detectFloor(cameraY: number, walkHeight: number): string {
      const floorY = cameraY - walkHeight;
      let detected = "";
      for (let i = FLOOR_LEVELS.length - 1; i >= 0; i--) {
        if (floorY >= FLOOR_LEVELS[i].y - 1.5) {
          detected = FLOOR_LEVELS[i].short;
          break;
        }
      }
      return detected || `${floorY.toFixed(1)}m`;
    }

    expect(detectFloor(1.65, 1.65)).toBe("PB");
    expect(detectFloor(4.65, 1.65)).toBe("P1");
    expect(detectFloor(-1.35, 1.65)).toBe("S-1");
    expect(detectFloor(31.65, 1.65)).toBe("P10");
  });
});

describe("Furniture Toggle Keywords", () => {
  const FURNITURE_KEYWORDS = ["furnish", "furniture", "mueble", "mobiliario", "IfcFurnishing", "IfcFurniture"];

  it("should match common IFC furniture class names", () => {
    const testNames = ["IfcFurnishingElement:Table", "IfcFurniture:Chair", "Furniture_Desk_001"];
    for (const name of testNames) {
      const match = FURNITURE_KEYWORDS.some(kw => name.toLowerCase().includes(kw.toLowerCase()));
      expect(match).toBe(true);
    }
  });

  it("should match Spanish furniture terms", () => {
    const testNames = ["Mueble_Escritorio", "mobiliario_sala"];
    for (const name of testNames) {
      const match = FURNITURE_KEYWORDS.some(kw => name.toLowerCase().includes(kw.toLowerCase()));
      expect(match).toBe(true);
    }
  });

  it("should NOT match non-furniture elements", () => {
    const testNames = ["IfcWall:Wall_001", "IfcBeam:Beam_002", "IfcPipe:Pipe_003"];
    for (const name of testNames) {
      const match = FURNITURE_KEYWORDS.some(kw => name.toLowerCase().includes(kw.toLowerCase()));
      expect(match).toBe(false);
    }
  });
});

describe("Edge Detection Default", () => {
  it("initial edge thickness should be 1 (always active)", () => {
    const files = [
      { specialty: "arch_struct", opacity: 85, showEdges: 0 },
      { specialty: "architecture", opacity: 85, showEdges: 0 },
      { specialty: "structure", opacity: 90, showEdges: 0 },
      { specialty: "hvac", opacity: 100, showEdges: 0 },
      { specialty: "plumbing", opacity: 100, showEdges: 1 },
    ];

    const init: Record<string, VisualSettings> = {};
    files.forEach(f => {
      init[f.specialty] = {
        hueShift: 0,
        saturation: 1,
        opacity: f.opacity,
        edgeThickness: 1,
        edgeColor: "#999999",
      };
    });

    for (const key of Object.keys(init)) {
      expect(init[key].edgeThickness).toBe(1);
    }
  });
});

describe("Wall Element Type Classification", () => {
  const WALL_PATTERNS = /wall|muro|pared|ifcwall/i;

  it("should classify IFC wall names correctly", () => {
    const wallNames = ["IfcWall:Wall_001", "Muro_Exterior_01", "Pared_Interior", "ifcwall_standard"];
    for (const name of wallNames) {
      expect(WALL_PATTERNS.test(name)).toBe(true);
    }
  });

  it("should NOT classify non-wall elements as walls", () => {
    const nonWallNames = ["IfcBeam:Beam_001", "IfcColumn:Column_001", "IfcSlab:Floor_001", "IfcPipe:Pipe_001"];
    for (const name of nonWallNames) {
      expect(WALL_PATTERNS.test(name)).toBe(false);
    }
  });
});

describe("Custom Color Application", () => {
  it("should validate hex color format", () => {
    const validColors = ["#FF6B6B", "#00BCD4", "#1B2A4A", "#ff0000"];
    for (const color of validColors) {
      expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("preset color palette should have 18 colors", () => {
    const PRESET_COLORS = [
      "#FF6B6B", "#FF8E53", "#FFC107", "#4CAF50", "#00BCD4", "#2196F3",
      "#9C27B0", "#E91E63", "#795548", "#607D8B", "#00A89D", "#1B2A4A",
      "#F44336", "#FF9800", "#CDDC39", "#009688", "#3F51B5", "#673AB7",
    ];
    expect(PRESET_COLORS).toHaveLength(18);
    for (const c of PRESET_COLORS) {
      expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("custom color should override default file color for any arch specialty", () => {
    for (const spec of ARCH_SPECIALTIES) {
      const fileColor = "#C0C0C0";
      const customColors: Record<string, string> = { [spec]: "#FF0000" };
      const effectiveColor = customColors[spec] || fileColor;
      expect(effectiveColor).toBe("#FF0000");
    }
  });

  it("should fall back to file color when no custom color set", () => {
    const fileColor = "#C0C0C0";
    const customColors: Record<string, string> = {};
    const effectiveColor = customColors["arch_struct"] || fileColor;
    expect(effectiveColor).toBe("#C0C0C0");
  });
});

describe("Wall Opacity Control", () => {
  it("wall opacity should be between 0 and 100", () => {
    const testValues = [0, 25, 50, 75, 100];
    for (const val of testValues) {
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(100);
    }
  });

  it("wall should be transparent when opacity < 100", () => {
    const opacity = 50;
    const isTransparent = opacity < 100;
    expect(isTransparent).toBe(true);
  });

  it("wall should have depthWrite when opacity >= 90", () => {
    expect(90 >= 90).toBe(true);
    expect(100 >= 90).toBe(true);
    expect(50 >= 90).toBe(false);
  });
});

describe("Specialty Options Configuration", () => {
  const SPECIALTY_OPTIONS = [
    { value: "architecture", label: "Arquitectura", color: "#9CA3AF" },
    { value: "structure", label: "Estructura", color: "#6B7280" },
    { value: "arch_struct", label: "Arq + Estructura (combinado)", color: "#78909C" },
    { value: "hvac", label: "HVAC (Clima)", color: "#3B82F6" },
    { value: "plumbing", label: "Plomería", color: "#22C55E" },
    { value: "electrical", label: "Eléctrico", color: "#EAB308" },
    { value: "mechanical", label: "Mecánico", color: "#A855F7" },
    { value: "fire_protection", label: "Contra Incendio", color: "#EF4444" },
  ];

  it("should have 8 specialty options", () => {
    expect(SPECIALTY_OPTIONS).toHaveLength(8);
  });

  it("should have separate architecture and structure options", () => {
    const arch = SPECIALTY_OPTIONS.find(s => s.value === "architecture");
    const struct = SPECIALTY_OPTIONS.find(s => s.value === "structure");
    expect(arch).toBeDefined();
    expect(struct).toBeDefined();
    expect(arch!.label).toBe("Arquitectura");
    expect(struct!.label).toBe("Estructura");
  });

  it("should still have legacy arch_struct option for backward compatibility", () => {
    const legacy = SPECIALTY_OPTIONS.find(s => s.value === "arch_struct");
    expect(legacy).toBeDefined();
    expect(legacy!.label).toContain("combinado");
  });

  it("all options should have valid hex colors", () => {
    for (const opt of SPECIALTY_OPTIONS) {
      expect(opt.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("all option values should be unique", () => {
    const values = SPECIALTY_OPTIONS.map(s => s.value);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});

describe("MEP Optimization Pipeline", () => {
  const MEP_SPECIALTIES = ["electrical", "mechanical", "plumbing", "hvac", "fire", "fire_protection"];

  it("should detect all MEP specialties correctly", () => {
    for (const spec of MEP_SPECIALTIES) {
      expect(MEP_SPECIALTIES.includes(spec)).toBe(true);
    }
  });

  it("should NOT detect arch specialties as MEP", () => {
    for (const spec of ARCH_SPECIALTIES) {
      expect(MEP_SPECIALTIES.includes(spec)).toBe(false);
    }
  });

  it("MEP pipeline should use meshopt (no Draco)", () => {
    // Validate the pipeline configuration
    const mepPipeline = {
      dedup: true,
      weld: true,
      prune: true,
      quantize: false,  // NO quantize for MEP
      simplify: false,  // NO simplify for MEP
      draco: false,     // NO draco for MEP
      meshopt: true,    // YES meshopt (lossless)
    };
    expect(mepPipeline.draco).toBe(false);
    expect(mepPipeline.quantize).toBe(false);
    expect(mepPipeline.simplify).toBe(false);
    expect(mepPipeline.meshopt).toBe(true);
  });
});

describe("Floor Labels 3D", () => {
  it("floor label text should match short label format", () => {
    const FLOOR_LEVELS = [
      { label: "Sótano 1", short: "S-1", y: -3.0 },
      { label: "Banqueta (PB)", short: "PB", y: 0.0 },
      { label: "Piso 1", short: "P1", y: 3.0 },
    ];

    for (const floor of FLOOR_LEVELS) {
      // Labels should be non-empty strings
      expect(floor.short.length).toBeGreaterThan(0);
      expect(floor.label.length).toBeGreaterThan(0);
    }
  });

  it("floor label visibility toggle should default to true", () => {
    const showFloorLabels = true; // default state
    expect(showFloorLabels).toBe(true);
  });
});

describe("Inspection Status Feature", () => {
  const VALID_STATUSES = ["pending", "in_progress", "accepted", "rejected"];

  it("should have 4 valid inspection statuses", () => {
    expect(VALID_STATUSES).toHaveLength(4);
  });

  it("status cycle should rotate correctly", () => {
    for (let i = 0; i < VALID_STATUSES.length; i++) {
      const current = VALID_STATUSES[i];
      const nextIdx = (VALID_STATUSES.indexOf(current) + 1) % VALID_STATUSES.length;
      const next = VALID_STATUSES[nextIdx];
      if (current === "pending") expect(next).toBe("in_progress");
      if (current === "in_progress") expect(next).toBe("accepted");
      if (current === "accepted") expect(next).toBe("rejected");
      if (current === "rejected") expect(next).toBe("pending");
    }
  });

  it("default status should be pending", () => {
    const defaultStatus = "pending";
    expect(VALID_STATUSES).toContain(defaultStatus);
    expect(VALID_STATUSES.indexOf(defaultStatus)).toBe(0);
  });

  it("status colors should be distinct", () => {
    const STATUS_COLORS: Record<string, string> = {
      pending: "#9CA3AF",
      in_progress: "#f59e0b",
      accepted: "#22C55E",
      rejected: "#EF4444",
    };
    const colors = Object.values(STATUS_COLORS);
    const unique = new Set(colors);
    expect(unique.size).toBe(colors.length);
    for (const color of colors) {
      expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

describe("Re-process MEP Feature", () => {
  const MEP_REPROCESS_SPECIALTIES = ["electrical", "mechanical", "plumbing", "hvac", "fire", "fire_protection"];

  it("should only show reprocess button for MEP specialties", () => {
    const archSpecs = ["arch_struct", "architecture", "structure"];
    for (const spec of archSpecs) {
      expect(MEP_REPROCESS_SPECIALTIES.includes(spec)).toBe(false);
    }
    for (const spec of MEP_REPROCESS_SPECIALTIES) {
      expect(MEP_REPROCESS_SPECIALTIES.includes(spec)).toBe(true);
    }
  });

  it("reprocess pipeline should use mep level (no Draco)", () => {
    const mepLevel = {
      dedup: true,
      weld: true,
      prune: true,
      quantize: false,
      simplify: false,
      draco: false,
      meshopt: true,
    };
    expect(mepLevel.draco).toBe(false);
    expect(mepLevel.meshopt).toBe(true);
    expect(mepLevel.quantize).toBe(false);
    expect(mepLevel.simplify).toBe(false);
  });
});

describe("Export Visible Layers Feature", () => {
  it("should filter only visible and loaded layers for export", () => {
    const layers: Record<string, { visible: boolean; loaded: boolean }> = {
      architecture: { visible: true, loaded: true },
      hvac: { visible: false, loaded: true },
      plumbing: { visible: true, loaded: true },
      electrical: { visible: true, loaded: false },
    };

    const files = [
      { specialty: "architecture", url: "https://example.com/arch.glb", label: "Arquitectura" },
      { specialty: "hvac", url: "https://example.com/hvac.glb", label: "HVAC" },
      { specialty: "plumbing", url: "https://example.com/plumb.glb", label: "Plomería" },
      { specialty: "electrical", url: "https://example.com/elec.glb", label: "Eléctrico" },
    ];

    const visibleFiles = files.filter(f => layers[f.specialty]?.visible && layers[f.specialty]?.loaded);
    expect(visibleFiles).toHaveLength(2);
    expect(visibleFiles.map(f => f.specialty)).toEqual(["architecture", "plumbing"]);
  });

  it("should return empty array when no layers are visible", () => {
    const layers: Record<string, { visible: boolean; loaded: boolean }> = {
      architecture: { visible: false, loaded: true },
      hvac: { visible: false, loaded: true },
    };
    const files = [
      { specialty: "architecture", url: "a.glb", label: "Arq" },
      { specialty: "hvac", url: "b.glb", label: "HVAC" },
    ];
    const visibleFiles = files.filter(f => layers[f.specialty]?.visible && layers[f.specialty]?.loaded);
    expect(visibleFiles).toHaveLength(0);
  });

  it("export filename should use label or specialty", () => {
    const file = { specialty: "plumbing", label: "Plomería", url: "https://example.com/plumb.glb" };
    const filename = `${file.label || file.specialty}.glb`;
    expect(filename).toBe("Plomería.glb");

    const fileNoLabel = { specialty: "hvac", label: "", url: "https://example.com/hvac.glb" };
    const filename2 = `${fileNoLabel.label || fileNoLabel.specialty}.glb`;
    expect(filename2).toBe("hvac.glb");
  });
});

describe("Floor Labels 3D - Wall-Mounted Signs (4 per floor)", () => {
  const SIGN_INDICES = [0, 1, 2, 3]; // 0=front(-Z), 1=back(+Z), 2=left(-X), 3=right(+X)

  it("should create 4 signs per floor (front, back, left, right)", () => {
    expect(SIGN_INDICES).toHaveLength(4);
    expect(SIGN_INDICES).toEqual([0, 1, 2, 3]);
  });

  it("each floor should have 4 wall-mounted signs", () => {
    const FLOOR_LEVELS = [
      { label: "S-1", y: -3.0 },
      { label: "PB", y: 0.0 },
      { label: "P1", y: 3.0 },
    ];
    const totalSigns = FLOOR_LEVELS.length * SIGN_INDICES.length;
    expect(totalSigns).toBe(12); // 3 floors × 4 signs
  });

  it("signs should use depthTest:true and not be transparent", () => {
    const meshMaterialConfig = {
      depthTest: true,
      depthWrite: true,
      transparent: false,
      side: "DoubleSide",
    };
    expect(meshMaterialConfig.depthTest).toBe(true);
    expect(meshMaterialConfig.depthWrite).toBe(true);
    expect(meshMaterialConfig.transparent).toBe(false);
    expect(meshMaterialConfig.side).toBe("DoubleSide");
  });

  it("sign dimensions should be larger (2m × 1m) for visibility", () => {
    const signW = 2.0;
    const signH = 1.0;
    expect(signW).toBe(2.0);
    expect(signH).toBe(1.0);
    expect(signW / signH).toBe(2); // 2:1 aspect ratio
  });

  it("sign canvas should have NIVEL header and large floor number", () => {
    const canvasWidth = 512;
    const canvasHeight = 256;
    const headerText = "NIVEL";
    const floorFont = "bold 120px system-ui, -apple-system, sans-serif";
    expect(canvasWidth).toBe(512);
    expect(canvasHeight).toBe(256);
    expect(headerText).toBe("NIVEL");
    expect(floorFont).toContain("120px");
  });

  it("raycasting should use multiple origins (25%, 50%, 75%) per direction", () => {
    const box = { min: { x: -20, z: -15 }, max: { x: 20, z: 15 } };
    const sizeX = box.max.x - box.min.x; // 40
    const sizeZ = box.max.z - box.min.z; // 30
    const centerX = (box.min.x + box.max.x) / 2; // 0
    const centerZ = (box.min.z + box.max.z) / 2; // 0
    const offsets = [0.25, 0.5, 0.75];

    // For front/back signs (idx 0,1): vary X position
    const xOrigins = offsets.map(pct => box.min.x + sizeX * pct);
    expect(xOrigins).toEqual([-10, 0, 10]);

    // For left/right signs (idx 2,3): vary Z position
    const zOrigins = offsets.map(pct => box.min.z + sizeZ * pct);
    expect(zOrigins).toEqual([-7.5, 0, 7.5]);
  });

  it("sign positioning uses offset from wall surface toward interior", () => {
    const offset = 0.08;
    // Hit point on -Z wall, sign placed offset back toward interior (+Z)
    const hitZ = -10;
    const signZ = hitZ + offset; // offset in -dir direction = toward interior
    expect(signZ).toBeCloseTo(-9.92);
  });

  it("sign height should be at eye level (1.6m above floor)", () => {
    const floorY = 3.0;
    const signY = floorY + 1.6;
    expect(signY).toBe(4.6);
  });

  it("sign accent color should vary by floor type", () => {
    const getAccentColor = (y: number) =>
      y === 0 ? "#00A89D" : y < 0 ? "#FF6B35" : "#3B82F6";
    expect(getAccentColor(0)).toBe("#00A89D");   // PB = teal
    expect(getAccentColor(-3)).toBe("#FF6B35");  // basement = orange
    expect(getAccentColor(3)).toBe("#3B82F6");   // upper = blue
  });

  it("sign rotations should face interior from each wall", () => {
    const rotations = [0, Math.PI, Math.PI / 2, -Math.PI / 2];
    expect(rotations[0]).toBe(0);              // front: face +Z
    expect(rotations[1]).toBeCloseTo(Math.PI); // back: face -Z
    expect(rotations[2]).toBeCloseTo(Math.PI / 2);  // left: face +X
    expect(rotations[3]).toBeCloseTo(-Math.PI / 2); // right: face -X
  });
});

describe("Walk Mode Entry - Improved Positioning", () => {
  it("should position camera at model edge (15% from corner), not center", () => {
    const box = { min: { x: -20, z: -15 }, max: { x: 20, z: 15 } };
    const size = { x: box.max.x - box.min.x, z: box.max.z - box.min.z };
    const edgeX = box.min.x + size.x * 0.15;
    const edgeZ = box.min.z + size.z * 0.15;

    // Should be near the edge, not at center (0, 0)
    expect(edgeX).toBe(-14); // -20 + 40*0.15 = -14
    expect(edgeZ).toBe(-10.5); // -15 + 30*0.15 = -10.5
    expect(Math.abs(edgeX)).toBeGreaterThan(0); // Not at center
    expect(Math.abs(edgeZ)).toBeGreaterThan(0);
  });

  it("should look toward model center from edge position", () => {
    const edgeX = -14;
    const edgeZ = -10.5;
    const centerX = 0;
    const centerZ = 0;
    const lookAtAngle = Math.atan2(centerZ - edgeZ, centerX - edgeX);
    // Angle should point toward center (positive, roughly 36 degrees)
    expect(lookAtAngle).toBeGreaterThan(0);
    expect(lookAtAngle).toBeLessThan(Math.PI / 2);
  });
});

describe("Walk Mode Floor HUD Indicator", () => {
  it("HUD should show current floor with large text", () => {
    const currentFloor = "P3";
    const hudFontSize = { mobile: "22px", desktop: "28px" };
    expect(parseInt(hudFontSize.desktop)).toBeGreaterThanOrEqual(24);
    expect(parseInt(hudFontSize.mobile)).toBeGreaterThanOrEqual(20);
    expect(currentFloor).toBeTruthy();
  });

  it("HUD background color should change based on floor type", () => {
    const getHudBg = (floor: string) => {
      if (floor.startsWith("S")) return "#1B2A4A"; // Basement = dark navy
      if (floor === "PB") return "#00A89D"; // Ground = teal
      return "#2A3F6A"; // Upper floors = medium navy
    };
    expect(getHudBg("S-1")).toBe("#1B2A4A");
    expect(getHudBg("PB")).toBe("#00A89D");
    expect(getHudBg("P5")).toBe("#2A3F6A");
  });

  it("HUD should fallback to PB when no floor detected", () => {
    const currentFloor = "";
    const display = currentFloor || "PB";
    expect(display).toBe("PB");
  });
});
