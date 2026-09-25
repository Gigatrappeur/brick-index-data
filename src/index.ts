#!/usr/bin/env bun
// index.ts — Indexation complète (Rebrickable + LDraw)

import { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { readdir, exists } from "node:fs/promises";
import parser from "yargs-parser";
import LDrawParser from "@gigatrappeur/ldraw-parser";
// import { DATA_DIR } from "./paths";
import { classifyPart } from "./classify";
import { parseColorsCSV, parseElementsCSV, buildColorMapping } from "./csv";

const DATA_DIR: string = join(import.meta.dir, "..", "data")
const LDRAW_DIR = join(DATA_DIR, "ldraw");
const PARTS_DIR = join(LDRAW_DIR, "parts");

const DB_PATH = `${DATA_DIR}/brick-data.sqlite`
const REBRICKABLE_COLORS_PATH = join(DATA_DIR, "rebrickable-colors.csv");
const REBRICKABLE_ELEMENTS_PATH = join(DATA_DIR, "rebrickable-elements.csv");


const SCHEMA = `
CREATE TABLE IF NOT EXISTS parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_ldraw TEXT,
  description TEXT,
  ref_rebrickable TEXT,
  ref_lego TEXT,
  color INTEGER,
  category TEXT,
  subcategory TEXT,
  is_sticker INTEGER DEFAULT 0,
  UNIQUE(ref_ldraw, color, ref_lego)
);

CREATE INDEX IF NOT EXISTS idx_ref_ldraw ON parts(ref_ldraw);
CREATE INDEX IF NOT EXISTS idx_ref_rebrickable ON parts(ref_rebrickable);
CREATE INDEX IF NOT EXISTS idx_ref_lego ON parts(ref_lego);
CREATE INDEX IF NOT EXISTS idx_category ON parts(category);
CREATE INDEX IF NOT EXISTS idx_is_sticker ON parts(is_sticker);

CREATE VIRTUAL TABLE IF NOT EXISTS parts_fts USING fts5(
  id UNINDEXED,
  ref_ldraw, ref_lego, ref_rebrickable, description, category, subcategory,
  tokenize='unicode61 remove_diacritics 1'
);

CREATE TRIGGER IF NOT EXISTS parts_ai AFTER INSERT ON parts BEGIN
  INSERT INTO parts_fts(id, ref_ldraw, ref_lego, ref_rebrickable, description, category, subcategory)
  VALUES (new.id, new.ref_ldraw, new.ref_lego, new.ref_rebrickable, new.description, new.category, new.subcategory);
END;

CREATE TRIGGER IF NOT EXISTS parts_ad AFTER DELETE ON parts BEGIN
  DELETE FROM parts_fts WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS parts_au AFTER UPDATE ON parts BEGIN
  DELETE FROM parts_fts WHERE id = old.id;
  INSERT INTO parts_fts(id, ref_ldraw, ref_lego, ref_rebrickable, description, category, subcategory)
  VALUES (new.id, new.ref_ldraw, new.ref_lego, new.ref_rebrickable, new.description, new.category, new.subcategory);
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

async function indexParts(db: Database, filterParts?: string[]): Promise<IndexResult> {
	console.log("[index] Chargement CSV Rebrickable...");


	if (!await exists(REBRICKABLE_COLORS_PATH)) throw new Error(`CSV couleurs introuvable: ${REBRICKABLE_COLORS_PATH}`);
	if (!await exists(REBRICKABLE_ELEMENTS_PATH)) throw new Error(`CSV éléments introuvable: ${REBRICKABLE_ELEMENTS_PATH}`);

	const rbColors = parseColorsCSV(REBRICKABLE_COLORS_PATH);
	const rbElements = parseElementsCSV(REBRICKABLE_ELEMENTS_PATH);

	const elementsByPartNum = new Map<string, Array<{ elementId: string; colorId: number }>>();
	for (const el of rbElements) {
		if (!elementsByPartNum.has(el.partNum)) {
			elementsByPartNum.set(el.partNum, []);
		}
		elementsByPartNum.get(el.partNum)!.push({ elementId: el.elementId, colorId: el.colorId });
	}
	console.log(`[index] ${elementsByPartNum.size} numéros de pièce uniques`);

	console.log("[index] Chargement LDConfig...");
	const ldrawParser = new LDrawParser({ libraryRoot: LDRAW_DIR });
	const colorTable = await ldrawParser.colorTable.getTable()
	console.log(`[index] ${colorTable.size} couleurs LDraw chargées`);

	const { rbToLDrawColor } = buildColorMapping(rbColors, colorTable);
	console.log(`[index] ${rbToLDrawColor.size} couleurs Rebrickable mappées`);
	
	const allFilenames = (await readdir(PARTS_DIR, { withFileTypes: true }))
		.filter(d => d.isFile() && d.name.endsWith(".dat"))
		.map(d => d.name);

	let filenames: string[];
	if (filterParts && filterParts.length > 0) {
		const filterSet = new Set(filterParts);
		filenames = allFilenames.filter(f => filterSet.has(f.replace(".dat", "")));
		console.log(`[index] ${filenames.length} fichiers LDraw à indexer (filtre --parts)`);
	} else {
		const existingRefs = new Set(
			db.query("SELECT ref_ldraw FROM parts").all().map((r: any) => r.ref_ldraw),
		);
		filenames = allFilenames.filter(f => !existingRefs.has(f.replace(".dat", "")));
		console.log(`[index] ${filenames.length} fichiers LDraw à indexer (${allFilenames.length - filenames.length} déjà indexés)`);
	}

	let inserted = 0;
	let matched = 0;
	console.log("[index] Indexation des pièces...");
	db.run("BEGIN");

	let lastProgressTime = Date.now();
	for (let i = 0; i < filenames.length; i++) {
		const filename = filenames[i]!;
		const refLDraw = filename.replace(".dat", "");

		const now = Date.now();
		if (now - lastProgressTime >= 3000) {
			process.stdout.write(`\r  Progression: ${i}/${filenames.length} (${((i / filenames.length) * 100).toFixed(1)}%)`);
			lastProgressTime = now;
		}

		try {
			const file = await ldrawParser.parseOnly(filename);

			const description = file.meta.description || "";
			const rbKeyword = file.meta.keywords?.find(k => k.toLocaleLowerCase().startsWith("rebrickable"));
			const refRebrickable = rbKeyword?.substring(12) || refLDraw;

			if (refRebrickable && elementsByPartNum.has(refRebrickable)) {
				const elements = elementsByPartNum.get(refRebrickable)!;
				const { category, subcategory, isSticker } = classifyPart(description);
				for (const el of elements) {
					const ldrawColor = rbToLDrawColor.get(el.colorId) ?? el.colorId;
					db.run(`INSERT OR IGNORE INTO parts (ref_ldraw, description, ref_rebrickable, ref_lego, color, category, subcategory, is_sticker)
                  VALUES ($refLDraw, $description, $refRebrickable, $refLego, $color, $category, $subcategory, $isSticker)`,
						{ $refLDraw: refLDraw, $description: description, $refRebrickable: refRebrickable, $refLego: el.elementId, $color: ldrawColor, $category: category, $subcategory: subcategory, $isSticker: isSticker ? 1 : 0 } as never);
					inserted++;
					matched++;
				}
			} else {
				const { category, subcategory, isSticker } = classifyPart(description);
				db.run(`INSERT OR IGNORE INTO parts (ref_ldraw, description, ref_rebrickable, ref_lego, color, category, subcategory, is_sticker)
                VALUES ($refLDraw, $description, $refRebrickable, NULL, NULL, $category, $subcategory, $isSticker)`,
					{ $refLDraw: refLDraw, $description: description, $refRebrickable: refRebrickable, $category: category, $subcategory: subcategory, $isSticker: isSticker ? 1 : 0 } as never);
				inserted++;
			}
		} catch (err) {
			console.error(`\n✗ Erreur processing ${filename}:`, err);
		}
	}

	db.run("COMMIT");
	console.log(`\n[index] ${inserted} pièces insérées, ${matched} avec mapping Rebrickable`);

	const total = db.query("SELECT COUNT(*) as count FROM parts").get() as { count: number };
	const withRB = db.query("SELECT COUNT(*) as count FROM parts WHERE ref_rebrickable IS NOT NULL").get() as { count: number };
	const withLego = db.query("SELECT COUNT(*) as count FROM parts WHERE ref_lego IS NOT NULL").get() as { count: number };
	const withColor = db.query("SELECT COUNT(*) as count FROM parts WHERE color IS NOT NULL").get() as { count: number };

	return {
		inserted, matched,
		totalParts: total.count,
		withRebrickable: withRB.count,
		withLego: withLego.count,
		withColor: withColor.count,
	};
}

export async function run(args: string[] = []): Promise<void> {
	console.log("[index] Démarrage de l'indexation\n");

	const parsed = parser(args, {
		boolean: ["clean-before"],
		string: ["parts"],
		configuration: { "camel-case-expansion": false },
	});

	const cleanBefore = parsed["clean-before"] === true || parsed["cleanBefore"] === true;
	const rawParts = parsed['parts'] as string | string[] | undefined;
	const parts = Array.isArray(rawParts) ? rawParts : rawParts ? [rawParts] : [];

	if (cleanBefore) {
		console.log("[index] Mode clean: drop des tables avant indexation");
	}
	if (parts.length > 0) {
		console.log(`[index] Filtre --parts: ${parts.length} référence(s)`);
	}

	
	if (cleanBefore) {
		const db = new Database(DB_PATH);
		db.run("PRAGMA journal_mode = WAL");
		db.run("PRAGMA synchronous = NORMAL");
		db.run("DROP TABLE IF EXISTS parts_fts");
		db.run("DROP TABLE IF EXISTS parts");
		db.close();
		console.log("[index] Database nettoyé");
	}

	const db = new Database(DB_PATH);
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA synchronous = NORMAL");
	db.run(SCHEMA);
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
