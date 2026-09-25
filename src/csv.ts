import { parse } from "csv-parse/sync";
import { readFileSync } from "node:fs";

type CsvRecord = Record<string, string>;

function parseCsv(content: string, options: { columns?: boolean; skip_empty_lines?: boolean; trim?: boolean } = {}): CsvRecord[] {
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    ...options,
  }) as unknown as CsvRecord[];
}


export interface RebrickableColor {
  name: string;
  hex: string;
  is_trans: string;
}

export interface RebrickableElement {
  elementId: string;
  partNum: string;
  colorId: number;
}



export function parseColorsCSV(filePath: string): Map<number, RebrickableColor> {
  const content = readFileSync(filePath, "utf-8");
  const records = parseCsv(content);

  const map = new Map<number, RebrickableColor>();
  for (const row of records) {
    const id = parseInt(row.id ?? "");
    if (isNaN(id)) continue;
    map.set(id, { name: row.name ?? "", hex: row.rgb ?? "", is_trans: row.is_trans ?? "" });
  }
  return map;
}

export function parseElementsCSV(filePath: string): RebrickableElement[] {
  const content = readFileSync(filePath, "utf-8");
  const records = parseCsv(content);

  const elements: RebrickableElement[] = [];
  for (const row of records) {
    const partNum = row.part_num?.trim() ?? "";
    if (!partNum) continue;
    const colorId = parseInt(row.color_id ?? "");
    elements.push({ elementId: row.element_id?.trim() ?? "", partNum, colorId });
  }
  return elements;
}

export interface ColorMapping {
  rbToLDrawColor: Map<number, number>;
}

export function buildColorMapping(
  rbColors: Map<number, RebrickableColor>,
  ldrawColorTable: Map<number, { name: string; rgba?: [number, number, number, number]; isTransparent?: boolean }>,
): ColorMapping {
  const rbToLDrawColor = new Map<number, number>();

  for (const [rbId, rbColor] of rbColors) {
    if (ldrawColorTable.has(rbId)) {
      rbToLDrawColor.set(rbId, rbId);
      continue;
    }

    const rbHex = rbColor.hex.replace("#", "");
    const rbR = parseInt(rbHex.slice(0, 2), 16);
    const rbG = parseInt(rbHex.slice(2, 4), 16);
    const rbB = parseInt(rbHex.slice(4, 6), 16);

    for (const [ldCode, ldColor] of ldrawColorTable) {
      if (!ldColor.rgba) continue;
      const lr = Math.round(ldColor.rgba[0]! * 255);
      const lg = Math.round(ldColor.rgba[1]! * 255);
      const lb = Math.round(ldColor.rgba[2]! * 255);
      if (lr === rbR && lg === rbG && lb === rbB && ldColor.isTransparent === (rbColor.is_trans === "True")) {
        rbToLDrawColor.set(rbId, ldCode);
        break;
      }
    }
  }

  return { rbToLDrawColor };
}
