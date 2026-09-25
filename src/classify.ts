export interface PartClassification {
  category: string;
  subcategory: string;
  isSticker: boolean;
}

export function classifyPart(description: string): PartClassification {
  const desc = description.toLowerCase();
  if (desc.includes("sticker")) return { category: "Stickers", subcategory: "Stickers", isSticker: true };
  if (desc.includes("technic") || desc.includes("pin") || desc.includes("axel") || desc.includes("beam") || desc.includes("connector"))
    return { category: "Technic", subcategory: "Technic", isSticker: false };
  if (desc.includes("minifig") || desc.includes("figure") || desc.includes("head") || desc.includes("torso") || desc.includes("leg") || desc.includes("arm"))
    return { category: "Minifigures", subcategory: "Minifigures", isSticker: false };
  if (desc.includes("plate") || desc.includes("slope") || desc.includes("roof") || desc.includes("curved"))
    return { category: "Plates", subcategory: "Plates", isSticker: false };
  if (desc.includes("tile") || desc.includes("round") || desc.includes("modified"))
    return { category: "Tiles", subcategory: "Tiles", isSticker: false };
  if (desc.includes("brick") || desc.includes("bar") || desc.includes("hinge") || desc.includes("clip"))
    return { category: "Bricks", subcategory: "Bricks", isSticker: false };
  return { category: "Other", subcategory: "Other", isSticker: false };
}
