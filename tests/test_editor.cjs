'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');

async function loadModule(candidates, globalName) {
  let lastError = null;

  for (const rel of candidates) {
    const abs = path.resolve(ROOT, rel);
    try {
      const loaded = require(abs);
      if (loaded) return loaded;
    } catch (err) {
      lastError = err;
    }
  }

  if (globalName && global[globalName]) return global[globalName];

  for (const rel of candidates) {
    const abs = path.resolve(ROOT, rel);
    try {
      const loaded = await import(pathToFileURL(abs).href);
      if (loaded) return loaded.default || loaded;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error(`Unable to load module from ${candidates.join(', ')}`);
}

function textOfFile(file) {
  if (file == null) return '';
  if (typeof file === 'string') return file;
  if (typeof file.text === 'string') return file.text;
  if (file.bytes) return Buffer.from(file.bytes).toString('utf8');
  if (file.data) return Buffer.from(file.data).toString('utf8');
  if (file.buffer) return Buffer.from(file.buffer).toString('utf8');
  return String(file);
}

function getHero(bundle, index = 0) {
  if (bundle && bundle.data && Array.isArray(bundle.data.Hero)) {
    return bundle.data.Hero[index];
  }
  const files = bundle.files || bundle.rawFiles || bundle;
  let heroFile = files.Hero;

  if (typeof heroFile === 'string' || (heroFile && typeof heroFile.text === 'string')) {
    const text = textOfFile(heroFile);
    return JSON.parse(text)[index];
  }

  if (Array.isArray(heroFile)) return heroFile[index];
  if (heroFile && Array.isArray(heroFile.data)) return heroFile.data[index];
  if (heroFile && Array.isArray(heroFile.json)) return heroFile.json[index];
  if (heroFile && Array.isArray(heroFile.value)) return heroFile.value[index];

  if (typeof bundle.getFileText === 'function') {
    return JSON.parse(bundle.getFileText('Hero'))[index];
  }

  if (typeof bundle.toJSON === 'function') {
    const json = bundle.toJSON();
    return json.Hero[index];
  }

  throw new Error('Unable to read Hero array from bundle');
}

function getHeroText(bundle) {
  const files = bundle.files || bundle.rawFiles || bundle;
  const heroFile = files.Hero;

  if (typeof heroFile === 'string') return heroFile;
  if (heroFile && typeof heroFile.text === 'string') return heroFile.text;
  if (typeof bundle.getFileText === 'function') return bundle.getFileText('Hero');

  throw new Error('Unable to read Hero text from bundle');
}

function getSaveText(bundle) {
  const files = bundle.files || bundle.rawFiles || bundle;
  const saveFile = files.Save;

  if (typeof saveFile === 'string') return saveFile;
  if (saveFile && typeof saveFile.text === 'string') return saveFile.text;
  if (typeof bundle.getFileText === 'function') return bundle.getFileText('Save');

  throw new Error('Unable to read Save text from bundle');
}

async function main() {
  const Codec = await loadModule(
    [
      'src/lyz-codec.js',
      'js/codec.js',
      'codec.js',
      'public/js/codec.js',
      'dist/codec.js'
    ],
    'LyzCodec'
  );

  const Core = await loadModule(
    [
      'src/editor-core.js',
      'js/core.js',
      'core.js',
      'public/js/core.js',
      'dist/core.js'
    ],
    'LyzCore'
  );

  const CatalogData = await loadModule(
    [
      'src/catalog-data.js',
      'js/catalog-data.js',
      'catalog-data.js'
    ],
    'LyzCatalogData'
  );

  assert.ok(Codec, 'Codec should be available');
  assert.ok(Core, 'Core should be available');
  assert.equal(typeof Codec.createBundle, 'function');
  assert.equal(typeof Codec.decodeSlotFile, 'function');

  const heroText =
    '[{"heroID":0,"heroName":"용윤","heroFamilyName":"용","hp":100,"maxhp":100,"maxHP":100,' +
    '"baseAttri":[10,10,10,10,10,10],"maxAttri":[10,10,10,10,10,10],' +
    '"baseFightSkill":[10,10,10,10,10,10,10,10,10],' +
    '"maxFightSkill":[10,10,10,10,10,10,10,10,10],' +
    '"baseLivingSkill":[10,10,10,10,10,10,10,10,10],' +
    '"maxLivingSkill":[10,10,10,10,10,10,10,10,10],' +
    '"kungfuSkills":[],"attackSkillSaveRecord":[-1,-1,-1,-1,-1,-1,-1,-1],"heroTagData":[],' +
    '"itemListData":{"money":100,"maxWeight":100,"allItem":[]},"equipSkills":{}},' +
    '{"heroID":99,"heroName":"고정인물","keepExact":36.0},null]';

  const saveText = '{"chapter":1,"speEnhanceStone":0,"worldTime":{"year":1,"month":1,"day":1},"keepFloat":1.0}';
  const infoText =
    '{"SaveVersion":1,"SaveTime":"2026-01-01T00:00:00.000Z","SaveDetail":{"slot":"SaveSlot0"}}';
  const tempHeroText = '[]';

  const encodedGzip = zlib.gzipSync(Buffer.from(heroText, 'utf8'));
  const decoded = await Codec.decodeSlotFile('Hero', encodedGzip);

  assert.ok(decoded, 'decodeSlotFile should return a result');
  const decodedText =
    typeof decoded === 'string'
      ? decoded
      : typeof decoded.text === 'string'
        ? decoded.text
        : Buffer.from(decoded.bytes || decoded.data || decoded).toString('utf8');

  assert.ok(decodedText.includes('용윤'));
  assert.ok(decodedText.includes('\"keepExact\":36.0'));

  const encodedGzipBom = await Codec.encodeSlotFile(saveText, { isGzip: true, hasBom: true });
  const decodedGzipBom = await Codec.decodeSlotFile('Save', encodedGzipBom);
  assert.equal(decodedGzipBom.isGzip, true, 'BOM+GZip roundtrip should preserve isGzip');
  assert.equal(decodedGzipBom.hasBom, true, 'BOM+GZip roundtrip should preserve hasBom');
  assert.equal(decodedGzipBom.data.keepFloat, 1.0);

  await assert.rejects(
    () => Codec.decodeSlotFile('Hero', new Uint8Array([0xFF, 0xFE, 0xFD])),
    /문자 자료|형식/,
    'decodeSlotFile must reject invalid UTF-8 bytes'
  );

  const bundle = await Codec.createBundle({
    Info: infoText,
    Save: saveText,
    Hero: heroText,
    TempHero: tempHeroText
  });

  assert.ok(bundle, 'createBundle should return a bundle');

  const ref = Core.findPlayer(bundle);
  assert.ok(ref, 'Player hero must be found');

  let currentHero;
  Core.editHero(bundle, ref, { heroName: '영웅수정', money: 500 });
  currentHero = getHero(bundle, 0);
  assert.equal(currentHero.heroName, '영웅수정');
  assert.equal(currentHero.itemListData.money, 500);

  Core.editHeroStat(bundle, ref, 'baseAttri', 0, 50);
  currentHero = getHero(bundle, 0);
  assert.equal(currentHero.baseAttri[0], 50);

  const kId = CatalogData.kungfus && CatalogData.kungfus[0] ? CatalogData.kungfus[0].id : 0;
  Core.addKungFu(bundle, ref, kId);
  currentHero = getHero(bundle, 0);
  assert.ok(Array.isArray(currentHero.kungfuSkills));
  assert.ok(currentHero.kungfuSkills.length >= 1);

  Core.editKungFu(bundle, ref, 0, { lv: 9 });
  currentHero = getHero(bundle, 0);
  assert.ok(currentHero.kungfuSkills[0]);
  assert.equal(currentHero.kungfuSkills[0].lv, 9);

  Core.assignKungFu(bundle, ref, 'internal', 0);
  currentHero = getHero(bundle, 0);
  assert.ok(currentHero.equipSkills || currentHero.internalSkillSaveRecord !== undefined);

  Core.setAttackSkill(bundle, ref, 0, 0);
  currentHero = getHero(bundle, 0);
  assert.equal(currentHero.attackSkillSaveRecord[0], 0);

  const tId = CatalogData.tags && CatalogData.tags[0] ? CatalogData.tags[0].id : 0;
  Core.editTag(bundle, ref, 'add', 0, { tagID: tId, permanent: true });
  currentHero = getHero(bundle, 0);
  assert.ok(currentHero.heroTagData.length >= 1);

  const weapon = CatalogData.weapons && CatalogData.weapons[0] ? CatalogData.weapons[0] : { id: 0, subType: 0 };
  Core.addItem(bundle, ref, 0, weapon.subType != null ? weapon.subType : 0, weapon.id);
  currentHero = getHero(bundle, 0);
  assert.ok(Array.isArray(currentHero.itemListData.allItem) && currentHero.itemListData.allItem.length >= 1);

  Core.editRelation(bundle, ref, 'inTeam', true);
  currentHero = getHero(bundle, 0);
  assert.equal(currentHero.inTeam, true);

  if (typeof Core.displayRelations === 'function') {
    const rel = Core.displayRelations(bundle, currentHero);
    assert.ok(rel && typeof rel === 'object');
  }

  Core.editWorld(bundle, 'chapter', 2);
  Core.editWorld(bundle, 'speEnhanceStone', 99);

  const presets = Object.keys(Core.PRESETS || {});
  assert.equal(presets.length, 4, 'Core.PRESETS should contain exactly four presets');

  for (const name of presets) {
    let bPreset = Codec.createBundle({
      Info: infoText,
      Save: saveText,
      Hero: heroText,
      TempHero: tempHeroText
    });
    Core.applyPreset(bPreset, name);
    const pv = Core.validateBundle(bPreset);
    assert.ok(pv.ok === true, `Preset ${name} failed: ${JSON.stringify(pv)}`);
  }

  const serialized = Codec.serializeBundle(bundle);
  const finalHeroText = serialized.Hero.text;
  const finalSaveText = serialized.Save.text;

  assert.ok(finalHeroText.includes('36.0'), 'hero selective JSON should preserve 36.0');
  assert.ok(finalHeroText.includes('null'), 'hero selective JSON should preserve null');
  assert.ok(finalSaveText.includes('1.0'), 'save selective JSON should preserve 1.0');

  console.log('test_editor.cjs passed successfully');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
