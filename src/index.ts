#!/usr/bin/env bun
// index.ts — Indexation complète (Rebrickable + LDraw)

import { Database } from "bun:sqlite";
import { stat, readdir, exists } from "node:fs/promises";
import { join } from "node:path";
import parser from "yargs-parser";
import LDrawParser from "@gigatrappeur/ldraw-parser";
import { classifyPart } from "./classify";
import {
  parseColorsCSV,
  parseElementsCSV,
  buildColorMapping,
  parsePartsCSV,
  parsePartCategoriesCSV,
} from "./csv";

const DATA_DIR = join(import.meta.dir, "..", "data");
const LDRAW_DIR = join(DATA_DIR, "ldraw");
const PARTS_DIR = join(LDRAW_DIR, "parts");
const DB_PATH = join(DATA_DIR, "brick-data.sqlite");

const RB_COLORS = join(DATA_DIR, "rebrickable", "colors.csv");
const RB_ELEMENTS = join(DATA_DIR, "rebrickable", "elements.csv");
const RB_PARTS = join(DATA_DIR, "rebrickable", "parts.csv");
const RB_CATEGORIES = join(DATA_DIR, "rebrickable", "part_categories.csv");

const SHORTENED_KEYWORDS = new Set(["rebrickable", "bricklink", "ldraw"]);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref_ldraw TEXT,
    name TEXT,
    ref_rebrickable TEXT,
    ref_lego TEXT,
    color INTEGER,
    category TEXT,
    keywords TEXT,
    UNIQUE(ref_ldraw, color, ref_lego)
  );

  CREATE INDEX IF NOT EXISTS idx_ref_ldraw ON parts(ref_ldraw);
  CREATE INDEX IF NOT EXISTS idx_ref_rebrickable ON parts(ref_rebrickable);
  CREATE INDEX IF NOT EXISTS idx_ref_lego ON parts(ref_lego);
  CREATE INDEX IF NOT EXISTS idx_category ON parts(category);

  CREATE VIRTUAL TABLE IF NOT EXISTS parts_fts USING fts5(
    id UNINDEXED,
    ref_ldraw, ref_lego, ref_rebrickable, name, category, keywords,
    tokenize='unicode61 remove_diacritics 1'
  );

  CREATE TRIGGER IF NOT EXISTS parts_ai AFTER INSERT ON parts BEGIN
    INSERT INTO parts_fts(id, ref_ldraw, ref_lego, ref_rebrickable, name, category, keywords)
    VALUES (new.id, new.ref_ldraw, new.ref_lego, new.ref_rebrickable, new.name, new.category, new.keywords);
  END;

  CREATE TRIGGER IF NOT EXISTS parts_ad AFTER DELETE ON parts BEGIN
    DELETE FROM parts_fts WHERE id = old.id;
  END;

  CREATE TRIGGER IF NOT EXISTS parts_au AFTER UPDATE ON parts BEGIN
    DELETE FROM parts_fts WHERE id = old.id;
    INSERT INTO parts_fts(id, ref_ldraw, ref_lego, ref_rebrickable, name, category, keywords)
    VALUES (new.id, new.ref_ldraw, new.ref_lego, new.ref_rebrickable, new.name, new.category, new.keywords);
  END;
`;

export interface IndexResult {
  inserted: number;
  matched: number;
  totalParts: number;
  withRebrickable: number;
  withLego: number;
  withColor: number;
}

interface PartInfo {
  refLego: string | null;
  color: number | null;
  category: string;
  keywords: string;
}

function buildKeywords(
  partName: string,
  datKeywords: string[] | undefined,
  name: string,
  category: string,
): string {
  const tokens = new Set<string>();
  const add = (s: string) => {
    if (!s) return;
    for (const word of s.toLowerCase().split(/[\s\-.,;:()\/]+/)) {
      const w = word.trim();
      if (w.length > 1 && !SHORTENED_KEYWORDS.has(w)) {
        tokens.add(w);
      }
    }
  };
  add(partName);
  add(name);
  add(category);
  datKeywords?.forEach(add);
  return Array.from(tokens).join(" ");
}

function insertPart(
  db: Database,
  values: { refLDraw: string; name: string; refRebrickable: string; part: PartInfo },
): void {

  db.run<[string, string, string, string | null, number | null, string, string]>(
    `INSERT OR IGNORE INTO parts
     (ref_ldraw, name, ref_rebrickable, ref_lego, color, category, keywords)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
		values.refLDraw,
		values.name,
		values.refRebrickable,
		values.part.refLego,
		values.part.color,
		values.part.category,
		values.part.keywords
	]
  );
}

async function loadRebrickableData(_ldrawParser: LDrawParser): Promise<{
  elementsByPart: Map<string, Array<{ elementId: string; colorId: number }>>;
  partToCategory: Map<string, { catName: string; partName: string }>;
}> {
  console.log("[index] Chargement CSV Rebrickable...");
  await Promise.all([
    exists(RB_COLORS).then(v => { if (!v) throw new Error(`CSV couleurs introuvable: ${RB_COLORS}`); }),
    exists(RB_ELEMENTS).then(v => { if (!v) throw new Error(`CSV éléments introuvable: ${RB_ELEMENTS}`); }),
  ]);

  const rbColors = parseColorsCSV(RB_COLORS);
  const rbElements = parseElementsCSV(RB_ELEMENTS);

  const elementsByPart = new Map<string, Array<{ elementId: string; colorId: number }>>();
  for (const el of rbElements) {
    let list = elementsByPart.get(el.partNum);
    if (!list) {
      list = [];
      elementsByPart.set(el.partNum, list);
    }
    list!.push({ elementId: el.elementId, colorId: el.colorId });
  }
  console.log(`[index] ${elementsByPart.size} numéros de pièce uniques`);

  console.log("[index] Chargement catégories et pièces Rebrickable...");
  await Promise.all([
    exists(RB_PARTS).then(v => { if (!v) throw new Error(`CSV pièces introuvable: ${RB_PARTS}`); }),
    exists(RB_CATEGORIES).then(v => { if (!v) throw new Error(`CSV catégories introuvable: ${RB_CATEGORIES}`); }),
  ]);

  const rbCategories = parsePartCategoriesCSV(RB_CATEGORIES);
  const rbParts = parsePartsCSV(RB_PARTS);
  const partToCategory = new Map<string, { catName: string; partName: string }>();
  for (const [partNum, part] of rbParts) {
    if (part.catId && rbCategories.has(part.catId)) {
      partToCategory.set(partNum, {
        catName: rbCategories.get(part.catId)!.name,
        partName: part.name,
      });
    }
  }
  console.log(`[index] ${partToCategory.size} pièces avec catégorie`);

  return { elementsByPart, partToCategory };
}

async function loadColorMapping(
  ldrawParser: LDrawParser,
): Promise<Map<number, number>> {
  console.log("[index] Chargement LDConfig...");
  const colorTable = await ldrawParser.colorTable.getTable();
  console.log(`[index] ${colorTable.size} couleurs LDraw chargées`);

  const rbColors = parseColorsCSV(RB_COLORS);
  const { rbToLDrawColor } = buildColorMapping(rbColors, colorTable);
  console.log(`[index] ${rbToLDrawColor.size} couleurs Rebrickable mappées`);
  return rbToLDrawColor;
}

async function selectLdrawFiles(
  filterParts?: string[],
  existingRefs?: Set<string>,
): Promise<string[]> {
  const all = (await readdir(PARTS_DIR, { withFileTypes: true }))
    .filter(d => d.isFile() && d.name.endsWith(".dat"))
    .map(d => d.name);

  if (filterParts?.length) {
    const set = new Set(filterParts);
    return all.filter(f => set.has(f.replace(".dat", "")));
  }
  if (!existingRefs) return all;
  return all.filter(f => !existingRefs.has(f.replace(".dat", "")));
}

async function indexParts(db: Database, filterParts?: string[]): Promise<IndexResult> {
  const ldrawParser = new LDrawParser({ libraryRoot: LDRAW_DIR });
  const { elementsByPart, partToCategory } = await loadRebrickableData(ldrawParser);
  const rbToLDrawColor = await loadColorMapping(ldrawParser);

  const existingRefs = new Set(
    db.query<{ ref_ldraw: string }, []>("SELECT ref_ldraw FROM parts").all().map(r => r.ref_ldraw),
  );

  const filenames = await selectLdrawFiles(filterParts, existingRefs);
  const mode = filterParts?.length ? "filtre --parts" : `${existingRefs.size} déjà indexés`;
  console.log(`[index] ${filenames.length} fichiers LDraw à indexer (${mode})`);

  let inserted = 0;
  let matched = 0;
  let lastProgressTime = Date.now();

  console.log("[index] Indexation des pièces...");
  db.run("BEGIN");

  for (let i = 0; i < filenames.length; i++) {
    const filename = filenames[i]!;
    const refLDraw = filename.replace(".dat", "");

    if (Date.now() - lastProgressTime >= 3000) {
      process.stdout.write(
        `\r  Progression: ${i}/${filenames.length} (${((i / filenames.length) * 100).toFixed(1)}%)`,
      );
      lastProgressTime = Date.now();
    }

    try {
      const file = await ldrawParser.parseOnly(filename);
      const name = file.meta.description || "";
      const rbKeyword = file.meta.keywords?.find(k => k.toLowerCase().startsWith("rebrickable"));
      const refRebrickable = rbKeyword?.substring(12) || refLDraw;
      const datKeywords = file.meta.keywords;

      const category = (() => {
        const catInfo = partToCategory.get(refRebrickable);
        return catInfo?.catName || classifyPart(name).category;
      })();
      const partName = partToCategory.get(refRebrickable)?.partName || "";
      const keywords = buildKeywords(partName, datKeywords, name, category);

      if (refRebrickable && elementsByPart.has(refRebrickable)) {
        const elements = elementsByPart.get(refRebrickable)!;
        for (const el of elements) {
          const ldrawColor = rbToLDrawColor.get(el.colorId) ?? el.colorId;
          insertPart(db, { refLDraw, name, refRebrickable, part: { refLego: el.elementId, color: ldrawColor, category, keywords } });
          inserted++;
          matched++;
        }
      } else {
        insertPart(db, { refLDraw, name, refRebrickable, part: { refLego: null, color: null, category, keywords } });
        inserted++;
      }
    } catch (err) {
      console.error(`\n✗ Erreur processing ${filename}:`, err);
    }
  }

  db.run("COMMIT");
  console.log(`\n[index] ${inserted} pièces insérées, ${matched} avec mapping Rebrickable`);

  const stats = db.query<{ total: number; rb: number; lego: number; color: number }, []>(`
    SELECT
      COUNT(*) AS total,
      COUNT(ref_rebrickable) AS rb,
      COUNT(ref_lego) AS lego,
      COUNT(color) AS color
    FROM parts
  `).get();

  if (!stats) {
    return { inserted, matched, totalParts: 0, withRebrickable: 0, withLego: 0, withColor: 0 };
  }

  return {
    inserted, matched,
    totalParts: stats.total,
    withRebrickable: stats.rb,
    withLego: stats.lego,
    withColor: stats.color,
  };
}

function cleanDatabase(): void {
  const db = new Database(DB_PATH);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("DROP TABLE IF EXISTS parts_fts");
  db.run("DROP TABLE IF EXISTS parts");
  db.close();
}

function openDatabase(): Database {
  const db = new Database(DB_PATH);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run(SCHEMA);
  return db;
}

export async function run(args: string[] = []): Promise<void> {
  console.log("[index] Démarrage de l'indexation\n");

  const parsed = parser(args, {
    boolean: ["clean-before"],
    string: ["parts"],
    configuration: { "camel-case-expansion": false },
  });

  const cleanBefore = parsed["clean-before"] === true || parsed["cleanBefore"] === true;
  const rawParts = parsed["parts"] as string | string[] | undefined;
  const parts = Array.isArray(rawParts) ? rawParts : rawParts ? [rawParts] : [];

  if (cleanBefore) console.log("[index] Mode clean: drop des tables avant indexation");
  if (parts.length > 0) console.log(`[index] Filtre --parts: ${parts.length} référence(s)`);

  if (cleanBefore) cleanDatabase();

  const db = openDatabase();
  console.log("[index] Schema initialisé");

  const result = await indexParts(db, parts.length > 0 ? parts : undefined);
  db.close();

  console.log("\n[index] Statistiques finales:");
  console.log(`  Total pièces: ${result.totalParts}`);
  console.log(`  Avec mapping Rebrickable: ${result.withRebrickable}`);
  console.log(`  Avec mapping Lego: ${result.withLego}`);
  console.log(`  Avec couleur: ${result.withColor}`);

  const dbSize = (await stat(DB_PATH)).size;
  console.log(`  Base SQLite: ${(dbSize / 1024 / 1024).toFixed(2)} Mo`);
  console.log("\n[index] ✅ Indexation terminée");
}

// Exécution directe (bun run index.ts)
if (process.argv[1]?.replace(/\\/g, "/").endsWith("index.ts")) {
  run(process.argv.slice(2)).catch((err) => {
    console.error("[index] Erreur fatale:", err);
    process.exit(1);
  });
}
