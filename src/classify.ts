export interface PartClassification {
  category: string;
  subcategory: string;
  isSticker: boolean;
}

interface ClassificationRule {
  keywords: string[];
  category: string;
}

const RULES: ClassificationRule[] = [
  { keywords: ["sticker"], category: "Stickers" },
  { keywords: ["technic", "pin", "axel", "beam", "connector"], category: "Technic" },
  { keywords: ["minifig", "figure", "head", "torso", "leg", "arm"], category: "Minifigures" },
  { keywords: ["plate", "slope", "roof", "curved"], category: "Plates" },
  { keywords: ["tile", "round", "modified"], category: "Tiles" },
  { keywords: ["brick", "bar", "hinge", "clip"], category: "Bricks" },
];

export function classifyPart(description: string): PartClassification {
  const desc = description.toLowerCase();

  for (const rule of RULES) {
    if (rule.keywords.some(kw => desc.includes(kw))) {
      return { category: rule.category, subcategory: rule.category, isSticker: rule.category === "Stickers" };
    }
  }

  return { category: "Other", subcategory: "Other", isSticker: false };
}
