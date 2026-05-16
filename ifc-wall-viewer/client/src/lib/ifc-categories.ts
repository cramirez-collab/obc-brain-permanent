/**
 * IFC Category definitions for specialty-based visualization.
 * Each specialty maps IFC type IDs to visual properties.
 */

export interface SpecialtyConfig {
  id: string;
  label: string;
  typeIds: number[];
  color: [number, number, number];
  category: 'arquitectura' | 'estructura' | 'mecanica' | 'plomeria' | 'electrica' | 'proteccion_incendios' | 'otros';
  crystal: boolean;
  visible: boolean;
}

// web-ifc type constants
export const IFC_TYPES = {
  IFCWALL: 4238390680,
  IFCWALLSTANDARDCASE: 3512223829,
  IFCSLAB: 1529196076,
  IFCCOLUMN: 843113511,
  IFCBEAM: 753842376,
  IFCFOOTING: 900683007,
  IFCPILE: 3999819293,
  IFCSTAIR: 331165859,
  IFCSTAIRFLIGHT: 4252922144,
  IFCRAMP: 3024970846,
  IFCRAMPFLIGHT: 3283111854,
  IFCROOF: 2016517767,
  IFCCOVERING: 1973544240,
  IFCRAILING: 2262370178,
  IFCCURTAINWALL: 3495092785,
  IFCDUCTSEGMENT: 3518393246,
  IFCDUCTFITTING: 342316401,
  IFCAIRTERMINAL: 1634111441,
  IFCAIRTERMINALBOX: 177149247,
  IFCPIPESEGMENT: 3612865200,
  IFCPIPEFITTING: 4278956645,
  IFCFLOWTERMINAL: 2058353004,
  IFCSANITARYTERMINAL: 3053780830,
  IFCFLOWSEGMENT: 987401354,
  IFCCABLESEGMENT: 4217484030,
  IFCCABLEFITTING: 1051757585,
  IFCCABLECARRIERSEGMENT: 3758799889,
  IFCCABLECARRIERFITTING: 635142910,
  IFCELECTRICDISTRIBUTIONBOARD: 862014818,
  IFCLIGHTFIXTURE: 629592764,
  IFCOUTLET: 3694346114,
  IFCSWITCHINGDEVICE: 1162798199,
  IFCENERGYCONVERSIONDEVICE: 1658829314,
  IFCFLOWMOVINGDEVICE: 3132237377,
  IFCFLOWSTORAGEDEVICE: 707683696,
  IFCFLOWTREATMENTDEVICE: 2223149337,
  IFCUNITARYEQUIPMENT: 4292641817,
  IFCFIRESUPPRESSIONTERMINAL: 1360408905,
  IFCBUILDINGELEMENTPROXY: 1095909175,
  IFCPLATE: 3171933400,
  IFCMEMBER: 1073191201,
};

export const SPECIALTIES: SpecialtyConfig[] = [
  {
    id: "muros",
    label: "Muros",
    typeIds: [IFC_TYPES.IFCWALL, IFC_TYPES.IFCWALLSTANDARDCASE, IFC_TYPES.IFCCURTAINWALL],
    color: [0.53, 0.81, 1.0],
    category: "arquitectura",
    crystal: true,
    visible: true,
  },
  {
    id: "losas",
    label: "Losas",
    typeIds: [IFC_TYPES.IFCSLAB],
    color: [0.6, 0.65, 0.75],
    category: "arquitectura",
    crystal: true,
    visible: true,
  },
  {
    id: "columnas",
    label: "Columnas",
    typeIds: [IFC_TYPES.IFCCOLUMN],
    color: [0.7, 0.75, 0.85],
    category: "estructura",
    crystal: true,
    visible: true,
  },
  {
    id: "vigas",
    label: "Vigas",
    typeIds: [IFC_TYPES.IFCBEAM],
    color: [0.65, 0.7, 0.8],
    category: "estructura",
    crystal: true,
    visible: true,
  },
  {
    id: "cimentacion",
    label: "Cimentación",
    typeIds: [IFC_TYPES.IFCFOOTING, IFC_TYPES.IFCPILE],
    color: [0.8, 0.7, 0.5],
    category: "estructura",
    crystal: true,
    visible: true,
  },
  {
    id: "escaleras",
    label: "Escaleras",
    typeIds: [IFC_TYPES.IFCSTAIR, IFC_TYPES.IFCSTAIRFLIGHT, IFC_TYPES.IFCRAMP, IFC_TYPES.IFCRAMPFLIGHT],
    color: [0.9, 0.85, 0.65],
    category: "arquitectura",
    crystal: true,
    visible: true,
  },
  {
    id: "techos",
    label: "Techos / Cubiertas",
    typeIds: [IFC_TYPES.IFCROOF, IFC_TYPES.IFCCOVERING],
    color: [0.75, 0.6, 0.5],
    category: "arquitectura",
    crystal: true,
    visible: true,
  },
  {
    id: "barandales",
    label: "Barandales",
    typeIds: [IFC_TYPES.IFCRAILING],
    color: [0.6, 0.55, 0.45],
    category: "arquitectura",
    crystal: true,
    visible: true,
  },
  {
    id: "ductos_hvac",
    label: "Ductos HVAC",
    typeIds: [IFC_TYPES.IFCDUCTSEGMENT, IFC_TYPES.IFCDUCTFITTING, IFC_TYPES.IFCAIRTERMINAL, IFC_TYPES.IFCAIRTERMINALBOX],
    color: [0.0, 0.85, 0.45],
    category: "mecanica",
    crystal: false,
    visible: true,
  },
  {
    id: "tuberias",
    label: "Tuberías",
    typeIds: [IFC_TYPES.IFCPIPESEGMENT, IFC_TYPES.IFCPIPEFITTING, IFC_TYPES.IFCFLOWTERMINAL, IFC_TYPES.IFCSANITARYTERMINAL, IFC_TYPES.IFCFLOWSEGMENT],
    color: [0.2, 0.6, 1.0],
    category: "plomeria",
    crystal: false,
    visible: true,
  },
  {
    id: "electrico",
    label: "Eléctrico",
    typeIds: [IFC_TYPES.IFCCABLESEGMENT, IFC_TYPES.IFCCABLEFITTING, IFC_TYPES.IFCCABLECARRIERSEGMENT, IFC_TYPES.IFCCABLECARRIERFITTING, IFC_TYPES.IFCELECTRICDISTRIBUTIONBOARD, IFC_TYPES.IFCLIGHTFIXTURE, IFC_TYPES.IFCOUTLET, IFC_TYPES.IFCSWITCHINGDEVICE],
    color: [1.0, 0.85, 0.0],
    category: "electrica",
    crystal: false,
    visible: true,
  },
  {
    id: "equipos_mecanicos",
    label: "Equipos Mecánicos",
    typeIds: [IFC_TYPES.IFCENERGYCONVERSIONDEVICE, IFC_TYPES.IFCFLOWMOVINGDEVICE, IFC_TYPES.IFCFLOWSTORAGEDEVICE, IFC_TYPES.IFCFLOWTREATMENTDEVICE, IFC_TYPES.IFCUNITARYEQUIPMENT],
    color: [1.0, 0.5, 0.2],
    category: "mecanica",
    crystal: false,
    visible: true,
  },
  {
    id: "proteccion_incendios",
    label: "Protección Incendios",
    typeIds: [IFC_TYPES.IFCFIRESUPPRESSIONTERMINAL],
    color: [1.0, 0.2, 0.2],
    category: "proteccion_incendios",
    crystal: false,
    visible: true,
  },
  {
    id: "otros",
    label: "Otros Elementos",
    typeIds: [IFC_TYPES.IFCBUILDINGELEMENTPROXY, IFC_TYPES.IFCPLATE, IFC_TYPES.IFCMEMBER],
    color: [0.5, 0.5, 0.55],
    category: "otros",
    crystal: false,
    visible: false,
  },
];

export const CATEGORY_LABELS: Record<string, string> = {
  arquitectura: "Arquitectura",
  estructura: "Estructura",
  mecanica: "Mecánica",
  plomeria: "Plomería",
  electrica: "Eléctrica",
  proteccion_incendios: "Protección Incendios",
  otros: "Otros",
};

export const CATEGORY_COLORS: Record<string, string> = {
  arquitectura: "#87CEFA",
  estructura: "#B0C4DE",
  mecanica: "#00D96F",
  plomeria: "#3399FF",
  electrica: "#FFD900",
  proteccion_incendios: "#FF3333",
  otros: "#808088",
};
