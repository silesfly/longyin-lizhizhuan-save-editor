(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./lyz-codec.js'),
      require('./catalog-data.js')
    );
  } else {
    root.LyzCore = factory(root.LyzCodec, root.LyzCatalogData);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (LyzCodec, LyzCatalogData) {
  'use strict';

  var HERO_FILES = ['Hero', 'TempHero'];
  var ATTR_LABELS = ['완력', '민첩', '지력', '의지', '체질', '경맥'];
  var FIGHT_LABELS = ['내공', '경공', '절기', '권장', '검법', '도법', '장병기', '기관술', '사술'];
  var LIVING_LABELS = ['의술', '독술', '학식', '말재주', '채벌', '재배', '단조', '제약', '요리'];
  var RESOURCE_LABELS = ['은전', '식량', '목재', '광석', '약초'];

  var PRESETS = {
    starter_boost: { name: '초기 지원' },
    attribute_peak: { name: '속성 정점' },
    martial_master: { name: '무공 대가' },
    world_harmony: { name: '세계 조화' }
  };

  function own(obj, key) {
    return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
  }

  function clone(value) {
    if (value == null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(clone);
    var out = {};
    Object.keys(value).forEach(function (key) { out[key] = clone(value[key]); });
    return out;
  }

  function fail(message) {
    throw new Error(message);
  }

  function numberValue(value, label, min, max, integer) {
    var n = Number(value);
    if (!Number.isFinite(n) || (integer && Math.floor(n) !== n) ||
        (min != null && n < min) || (max != null && n > max)) {
      fail(label + ' 값이 올바르지 않습니다.');
    }
    return n;
  }

  function boolValue(value, label) {
    if (typeof value !== 'boolean') fail(label + ' 값은 참 또는 거짓이어야 합니다.');
    return value;
  }

  function heroesOf(bundle, file) {
    var data = bundle && (bundle.data || bundle.files || bundle);
    var list = data && data[file];
    if (!Array.isArray(list)) fail(file + ' 영웅 자료를 찾을 수 없습니다.');
    return list;
  }

  function saveOf(bundle) {
    var data = bundle && (bundle.data || bundle.files || bundle);
    var save = data && data.Save;
    if (!save || typeof save !== 'object') fail('저장 자료를 찾을 수 없습니다.');
    return save;
  }

  function markHero(bundle, file, index) {
    bundle.dirty = bundle.dirty || {};
    bundle.dirtyHeroIndices = bundle.dirtyHeroIndices || {};
    bundle.dirtyHeroIndices[file] = bundle.dirtyHeroIndices[file] || {};
    bundle.dirty[file] = true;
    bundle.dirtyHeroIndices[file][index] = true;
  }

  function markSave(bundle, key) {
    bundle.dirty = bundle.dirty || {};
    bundle.dirtySaveKeys = bundle.dirtySaveKeys || {};
    bundle.dirty.Save = true;
    bundle.dirtySaveKeys[key] = true;
  }

  function heroAt(bundle, ref) {
    if (!ref || HERO_FILES.indexOf(ref.file) < 0 ||
        !Number.isInteger(ref.index) || !Number.isInteger(ref.heroID)) {
      fail('영웅 위치 정보가 올바르지 않습니다.');
    }
    var hero = heroesOf(bundle, ref.file)[ref.index];
    if (!hero || hero.heroID !== ref.heroID) fail('영웅 자료가 변경되었거나 없습니다.');
    return hero;
  }

  function heroRef(bundle, file, index) {
    var hero = heroesOf(bundle, file)[index];
    if (!hero) fail('영웅 자료가 없습니다.');
    return { file: file, index: index, heroID: hero.heroID };
  }

  function findPlayer(bundle, required) {
    var list = heroesOf(bundle, 'Hero');
    var found = [];
    list.forEach(function (hero, index) {
      if (hero && hero.heroID === 0) found.push({ file: 'Hero', index: index, heroID: 0 });
    });
    if (found.length !== 1) {
      if (required !== false) fail(found.length ? '플레이어 영웅이 여러 명입니다.' : '플레이어 영웅이 없습니다.');
      return null;
    }
    return found[0];
  }

  function editHero(bundle, ref, field, value) {
    var hero = heroAt(bundle, ref);
    if (field && typeof field === 'object') {
      Object.keys(field).forEach(function (k) {
        if (k === 'money') {
          editInventory(bundle, ref, 'money', field[k]);
        } else {
          editHero(bundle, ref, k, field[k]);
        }
      });
      return hero;
    }
    var ranges = {
      age: [1, 200, true], belongForceID: [-1, 29, true],
      heroForceLv: [0, 10, true], atAreaID: [0, 78, true],
      badFame: [0, null, false], loyal: [0, 100, false], heroTagPoint: [0, null, false],
      hp: [0, null, false], maxhp: [0, null, false], realMaxHp: [0, null, false],
      power: [0, null, false], maxPower: [0, null, false], realMaxPower: [0, null, false],
      mana: [0, null, false], maxMana: [0, null, false], realMaxMana: [0, null, false],
      armor: [0, null, false], externalInjury: [0, null, false],
      internalInjury: [0, null, false], poisonInjury: [0, null, false]
    };
    var textFields = ['heroFamilyName', 'heroName', 'heroNickName'];
    if (textFields.indexOf(field) >= 0) {
      if (typeof value !== 'string') fail('이름 값은 글자여야 합니다.');
    } else if (field === 'isFemale' || field === 'inTeam') {
      value = boolValue(value, field === 'isFemale' ? '성별' : '동료 여부');
    } else if (field === 'fame' || field === 'favor') {
      value = numberValue(value, field, null, null, false);
    } else if (ranges[field]) {
      value = numberValue(value, field, ranges[field][0], ranges[field][1], ranges[field][2]);
    } else {
      fail('수정할 수 없는 영웅 항목입니다.');
    }
    hero[field] = value;
    markHero(bundle, ref.file, ref.index);
    return hero;
  }

  function editHeroStat(bundle, ref, field, index, value) {
    var hero = heroAt(bundle, ref);
    var lengths = {
      baseAttri: 6, maxAttri: 6,
      baseFightSkill: 9, maxFightSkill: 9,
      baseLivingSkill: 9, maxLivingSkill: 9
    };
    if (!own(lengths, field)) fail('수정할 수 없는 능력치 배열입니다.');
    var list = hero[field];
    if (!Array.isArray(list) || list.length !== lengths[field]) {
      fail('능력치 배열의 길이가 올바르지 않아 수정할 수 없습니다.');
    }
    if (!Number.isInteger(index) || index < 0 || index >= list.length) fail('능력치 위치가 올바르지 않습니다.');
    list[index] = numberValue(value, '능력치', 0, null, false);
    markHero(bundle, ref.file, ref.index);
    return hero;
  }

  function editKungFu(bundle, ref, index, changes) {
    var hero = heroAt(bundle, ref);
    var list = hero.kungfuSkills;
    if (!Array.isArray(list) || !list[index]) fail('무공 자료가 없습니다.');
    ['lv', 'fightExp', 'bookExp'].forEach(function (key) {
      if (!own(changes, key)) return;
      list[index][key] = numberValue(
        changes[key], key, key === 'lv' ? 1 : 0, key === 'lv' ? 10 : null, key === 'lv'
      );
    });
    markHero(bundle, ref.file, ref.index);
    return list[index];
  }

  function catalogRoot() {
    return LyzCatalogData && (LyzCatalogData.default || LyzCatalogData);
  }

  function rowsFor(kind) {
    var root = catalogRoot();
    if (!root) return [];
    var keys = {
      kungfus: ['kungfus', 'KungFu', 'kungFu', 'kungfu'],
      books: ['kungfus'],
      meds: ['meds', 'medicines', 'Medicine', 'Medicines'],
      foods: ['foods', 'Foods'],
      horses: ['horses', 'Horses'],
      weapons: ['weapons', 'Weapons'],
      armors: ['armors', 'Armor', 'Armors']
    }[kind] || [kind];
    for (var i = 0; i < keys.length; i++) {
      if (Array.isArray(root[keys[i]])) return root[keys[i]];
      if (root.catalog && Array.isArray(root.catalog[keys[i]])) return root.catalog[keys[i]];
    }
    return [];
  }

  function rowId(row) {
    if (!row) return undefined;
    return row.id != null ? row.id :
      row.skillID != null ? row.skillID :
      row.itemID != null ? row.itemID : row.ID;
  }

  function rowName(row) {
    return row && (row.name || row.itemName || row.skillName || row.Name);
  }

  function lookupCatalogName(kind, id, subType) {
    var rows = rowsFor(kind);
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (Number(rowId(row)) === Number(id) &&
          (subType == null || row.subType == null || Number(row.subType) === Number(subType))) {
        var name = rowName(row);
        if (typeof name === 'string' && name) return name;
      }
    }
    return '알 수 없는 항목 #' + id;
  }

  function addKungFu(bundle, ref, skillId) {
    var hero = heroAt(bundle, ref);
    var row = rowsFor('kungfus').filter(function (item) {
      return Number(rowId(item)) === Number(skillId);
    })[0];
    if (!row) fail('무공 목록에서 항목을 찾을 수 없습니다.');
    hero.kungfuSkills = Array.isArray(hero.kungfuSkills) ? hero.kungfuSkills : [];
    var skill = {
      skillID: Number(skillId),
      lv: 1,
      fightExp: 0.0,
      bookExp: 0.0,
      equiped: false,
      isNew: false,
      belongHeroID: hero.heroID,
      speEquipData: { heroSpeAddData: {} },
      equipUseSpeAddValue: 0.0,
      speUseData: { heroSpeAddData: {} },
      damageUseSpeAddValue: 0.0,
      selfUseSpeAddValue: 0.0,
      enemyUseSpeAddValue: 0.0,
      extraAddData: { heroSpeAddData: {} },
      maxManaChanged: false
    };
    hero.kungfuSkills.push(skill);
    markHero(bundle, ref.file, ref.index);
    return hero.kungfuSkills.length - 1;
  }

  function syncEquipped(hero) {
    if (!Array.isArray(hero.kungfuSkills)) return;
    var equipped = {};
    ['internalSkillSaveRecord', 'dodgeSkillSaveRecord', 'uniqueSkillSaveRecord'].forEach(function (key) {
      var index = Number(hero[key]);
      if (Number.isInteger(index) && index >= 0 && index < hero.kungfuSkills.length) equipped[index] = true;
    });
    if (Array.isArray(hero.attackSkillSaveRecord)) {
      hero.attackSkillSaveRecord.forEach(function (value) {
        var index = Number(value);
        if (Number.isInteger(index) && index >= 0 && index < hero.kungfuSkills.length) equipped[index] = true;
      });
    }
    hero.kungfuSkills.forEach(function (skill, index) {
      if (skill) skill.equiped = !!equipped[index];
    });
  }

  function assignKungFu(bundle, ref, slot, index, attackSlot) {
    var hero = heroAt(bundle, ref);
    var fields = {
      internal: 'internalSkillSaveRecord',
      dodge: 'dodgeSkillSaveRecord',
      unique: 'uniqueSkillSaveRecord'
    };
    if (slot === 'attack') {
      if (!Array.isArray(hero.attackSkillSaveRecord) || hero.attackSkillSaveRecord.length < 8) {
        fail('절기 장착 배열이 올바르지 않습니다.');
      }
      var targetSlot = Number.isInteger(attackSlot) ? attackSlot : 0;
      if (targetSlot < 0 || targetSlot > 7) fail('절기 장착 위치가 올바르지 않습니다.');
      if (!Number.isInteger(index) || index < -1 || index >= hero.kungfuSkills.length) fail('무공 위치가 올바르지 않습니다.');
      hero.attackSkillSaveRecord[targetSlot] = index;
    } else {
      var field = fields[slot];
      if (!field) fail('무공 장착 위치가 올바르지 않습니다.');
      if (!Number.isInteger(index) || index < 0 || index >= hero.kungfuSkills.length) fail('무공 위치가 올바르지 않습니다.');
      hero[field] = index;
    }
    syncEquipped(hero);
    markHero(bundle, ref.file, ref.index);
    return hero;
  }

  function setAttackSkill(bundle, ref, slotIndex, skillIndex) {
    return assignKungFu(bundle, ref, 'attack', skillIndex, slotIndex);
  }

  function editTag(bundle, ref, action, index, value) {
    var hero = heroAt(bundle, ref);
    hero.heroTagData = Array.isArray(hero.heroTagData) ? hero.heroTagData : [];
    if (action === 'add') {
      if (!value || !Number.isInteger(Number(value.tagID))) fail('특성 정보가 올바르지 않습니다.');
      hero.heroTagData.push({
        tagID: Number(value.tagID),
        leftTime: value.permanent ? -1.0 : numberValue(value.leftTime == null ? -1 : value.leftTime, '남은 기간', -1, null, false),
        sourceHero: value.sourceHero == null ? null : value.sourceHero
      });
    } else {
      if (!Number.isInteger(index) || !hero.heroTagData[index]) fail('특성 위치가 올바르지 않습니다.');
      if (action === 'remove') hero.heroTagData.splice(index, 1);
      else if (action === 'permanent') hero.heroTagData[index].leftTime = value ? -1.0 : 30.0;
      else fail('특성 수정 방식이 올바르지 않습니다.');
    }
    markHero(bundle, ref.file, ref.index);
    return hero.heroTagData;
  }

  function editInventory(bundle, ref, field, value) {
    var hero = heroAt(bundle, ref);
    var inv = hero.itemListData;
    if (!inv || typeof inv !== 'object') fail('소지품 자료를 찾을 수 없습니다.');
    if (field === 'money' || field === 'maxWeight') {
      inv[field] = numberValue(value, field, 0, null, field === 'money');
    } else {
      var list = inv.allItem;
      var index = value && value.index;
      var itemField = value && value.field;
      var itemValue = value && value.value;
      if (!Array.isArray(list) || !Number.isInteger(index) || !list[index]) fail('소지품 위치가 올바르지 않습니다.');
      if (itemField === 'enhanceLv') {
        if (list[index].equipmentData) {
          list[index].equipmentData.enhanceLv = numberValue(itemValue, '강화 등급', 0, 20, true);
        } else if (list[index].medFoodData) {
          list[index].medFoodData.enhanceLv = numberValue(itemValue, '강화 등급', 0, 20, true);
        } else {
          fail('강화할 수 없는 소지품입니다.');
        }
      } else if (['itemLv', 'rareLv', 'poisonNum'].indexOf(itemField) >= 0) {
        list[index][itemField] = numberValue(itemValue, itemField, 0, itemField === 'rareLv' ? 5 : null, itemField !== 'poisonNum');
      } else {
        fail('수정할 수 없는 소지품 항목입니다.');
      }
    }
    markHero(bundle, ref.file, ref.index);
    return inv;
  }

  function itemKind(type, subType) {
    if (type === 3) return 'books';
    if (type === 1) return 'meds';
    if (type === 2) return 'foods';
    if (type === 6 && subType === 0) return 'horses';
    if (type === 0 && subType === 0) return 'weapons';
    if (type === 0 && subType >= 1 && subType <= 3) return 'armors';
    return null;
  }

  function addItem(bundle, ref, type, subType, itemId) {
    var hero = heroAt(bundle, ref);
    var t = Number(type);
    var st = Number(subType);
    var idNum = Number(itemId);
    var kind = itemKind(t, st);
    if (!kind) fail('소지품 종류가 올바르지 않습니다.');
    var row = rowsFor(kind).filter(function (item) {
      return Number(rowId(item)) === idNum &&
        (item.subType == null || Number(item.subType) === st);
    })[0];
    if (!row) fail('목록에서 소지품 항목을 찾을 수 없습니다.');
    var inv = hero.itemListData;
    if (!inv || typeof inv !== 'object') fail('소지품 자료를 찾을 수 없습니다.');
    inv.allItem = Array.isArray(inv.allItem) ? inv.allItem : [];
    var name = rowName(row) || lookupCatalogName(kind, idNum, st);
    var item = {
      itemID: t === 3 ? 0 : idNum,
      type: t,
      subType: st,
      name: name,
      checkName: '없음',
      describe: '',
      value: 100,
      itemLv: 1,
      rareLv: 1,
      weight: t === 6 ? 10.0 : 1.0,
      isNew: false,
      poisonNum: 0.0,
      poisonNumDetected: false,
      equipmentData: t === 0 ? {
        enhanceLv: 0, littleType: st, attriType: 0,
        baseAddData: { heroSpeAddData: {} }, extraAddData: { heroSpeAddData: {} },
        equiped: false, animName: '', equipPoisonData: { poisonNum: 0.0, poisonBuffData: { heroSpeAddData: {} } },
        speEnhanceLv: 0, speWeightLv: 0
      } : null,
      medFoodData: (t === 1 || t === 2) ? {
        enhanceLv: 0,
        changeHeroState: { hp: 50.0, maxhp: 0.0, mana: 50.0, maxMana: 0.0, power: 20.0, maxPower: 0.0, externalInjury: 0.0, internalInjury: 0.0, poisonInjury: 0.0, changeAttri: [], charm: 0.0, buffData: { heroSpeAddData: {} } },
        randomSpeAddValue: 0, extraAddData: { heroSpeAddData: {} }
      } : null,
      bookData: t === 3 ? { skillID: idNum } : null,
      treasureData: null,
      materialData: null,
      horseData: t === 6 ? {
        equiped: false, speed: 50.0, power: 20.0, sprint: 30.0, resist: 20.0,
        speedAdd: 0.0, powerAdd: 0.0, sprintAdd: 0.0, resistAdd: 0.0, maxWeightAdd: 0.0,
        nowPower: 50.0, favorRate: 0.5, sprintTimeLeft: 0.0, sprintTimeCd: 0.0
      } : null
    };
    inv.allItem.push(item);
    markHero(bundle, ref.file, ref.index);
    return inv.allItem.length - 1;
  }

  function heroNameMap(bundle) {
    var map = {};
    heroesOf(bundle, 'Hero').forEach(function (hero) {
      if (hero) map[hero.heroID] = hero.heroName || hero.heroFamilyName || ('영웅 #' + hero.heroID);
    });
    return map;
  }

  function displayRelations(bundle, hero) {
    var names = heroNameMap(bundle);
    var result = {};
    ['inTeam', 'teamMates', 'Lover', 'Brothers', 'Friends', 'Haters'].forEach(function (key) {
      var value = hero[key];
      if (Array.isArray(value)) {
        result[key] = value.map(function (id) { return { heroID: id, name: names[id] || ('영웅 #' + id) }; });
      } else if (typeof value === 'number') {
        result[key] = { heroID: value, name: value < 0 ? '없음' : (names[value] || ('영웅 #' + value)) };
      } else {
        result[key] = value;
      }
    });
    return result;
  }

  function editRelation(bundle, ref, field, value) {
    var hero = heroAt(bundle, ref);
    var allowed = ['inTeam', 'teamMates', 'Lover', 'Brothers', 'Friends', 'Haters'];
    if (allowed.indexOf(field) < 0) fail('수정할 수 없는 인연 항목입니다.');
    if (field === 'inTeam') {
      hero.inTeam = boolValue(value, '동행 여부');
    } else if (field === 'Lover') {
      if (value !== null && !Number.isInteger(Number(value))) fail('연인 값이 올바르지 않습니다.');
      hero.Lover = value === null ? -1 : Number(value);
    } else {
      if (!Array.isArray(value) || value.some(function (id) { return !Number.isInteger(Number(id)); })) {
        fail('인연 목록이 올바르지 않습니다.');
      }
      hero[field] = value.map(Number);
    }
    markHero(bundle, ref.file, ref.index);
    return hero[field];
  }

  function editWorld(bundle, key, value, index, field) {
    var save = saveOf(bundle);
    if (key === 'worldTime') {
      if (!value || typeof value !== 'object') fail('날짜 정보가 올바르지 않습니다.');
      var time = save.worldTime || {};
      ['year', 'month', 'day'].forEach(function (part) {
        if (own(value, part)) {
          time[part] = numberValue(value[part], part, part === 'year' ? 0 : 1, part === 'month' ? 12 : part === 'day' ? 30 : null, true);
        }
      });
      save.worldTime = time;
      markSave(bundle, key);
      return time;
    }
    if (key === 'Forces' || key === 'Areas') {
      if (!Array.isArray(save[key]) || !Number.isInteger(index) || !save[key][index]) fail('세계 자료 위치가 올바르지 않습니다.');
      var allowed = key === 'Forces'
        ? { forceLv: true, resourceStore: true }
        : { people: true, maxPeople: true, safe: true, support: true, defence: true, belongForceID: true };
      if (!own(allowed, field)) fail('수정할 수 없는 세계 항목입니다.');
      if (key === 'Forces' && field === 'resourceStore') {
        var store = save.Forces[index].resourceStore;
        if (!Array.isArray(store) || store.length !== 5) fail('세력 자원 배열의 길이가 올바르지 않습니다.');
        var resourceIndex = Number(value && value.index);
        if (!Number.isInteger(resourceIndex) || resourceIndex < 0 || resourceIndex > 4) fail('자원 위치가 올바르지 않습니다.');
        store[resourceIndex] = numberValue(value.value, '자원', 0, null, false);
      } else {
        var limits = key === 'Forces' ? { forceLv: [0, 10] } : { belongForceID: [-1, 29] };
        var range = limits[field] || [0, null];
        save[key][index][field] = numberValue(value, field, range[0], range[1], field === 'forceLv' || field === 'belongForceID');
      }
      markSave(bundle, key);
      return save[key][index];
    }
    var ranges = {
      chapter: [-1, 4, true], gameMode: [0, 1, true], gameDifficulty: [0, 3, true], hour: [0, 24, false],
      speEnhanceStone: [0, null, true], totalFightCount: [0, null, true],
      totalWinFightCount: [0, null, true], totalEnemyKilled: [0, null, true], totalBadFame: [0, null, false]
    };
    if (key === 'relaxMode' || key === 'cheating' || key === 'cheated') {
      save[key] = boolValue(value, key);
    } else if (ranges[key]) {
      save[key] = numberValue(value, key, ranges[key][0], ranges[key][1], ranges[key][2]);
    } else {
      fail('수정할 수 없는 세계 항목입니다.');
    }
    markSave(bundle, key);
    return save[key];
  }

  function applyPreset(bundle, presetId) {
    if (!own(PRESETS, presetId)) fail('프리셋을 찾을 수 없습니다.');
    var ref = findPlayer(bundle, true);
    var hero = heroAt(bundle, ref);
    var inv = hero.itemListData;
    if (!inv || typeof inv !== 'object') fail('소지품 자료를 찾을 수 없습니다.');

    if (presetId === 'starter_boost') {
      inv.money = numberValue(inv.money || 0, '은전', 0, null, false) + 50000;
      inv.maxWeight = numberValue(inv.maxWeight || 0, '적재 상한', 0, null, false) + 200;
      hero.heroTagPoint = numberValue(hero.heroTagPoint || 0, '특성점', 0, null, false) + 500;
      hero.fame = numberValue(hero.fame || 0, '명성', null, null, false) + 1000;
      hero.hp = hero.maxhp == null ? hero.hp : hero.maxhp;
      hero.power = hero.maxPower == null ? hero.power : hero.maxPower;
      hero.mana = hero.realMaxMana == null ? hero.mana : hero.realMaxMana;
      markHero(bundle, ref.file, ref.index);
    } else if (presetId === 'attribute_peak') {
      [['baseAttri', 6], ['maxAttri', 6], ['baseFightSkill', 9], ['maxFightSkill', 9],
       ['baseLivingSkill', 9], ['maxLivingSkill', 9]].forEach(function (entry) {
        var values = hero[entry[0]];
        if (!Array.isArray(values) || values.length !== entry[1]) fail('능력치 배열의 길이가 올바르지 않아 프리셋을 적용할 수 없습니다.');
        hero[entry[0]] = values.map(function (n) { return Math.max(100, Number(n) || 0); });
      });
      hero.externalInjury = 0;
      hero.internalInjury = 0;
      hero.poisonInjury = 0;
      markHero(bundle, ref.file, ref.index);
    } else if (presetId === 'martial_master') {
      if (!Array.isArray(hero.kungfuSkills)) fail('무공 자료를 찾을 수 없습니다.');
      hero.kungfuSkills.forEach(function (skill) { if (skill) skill.lv = 10; });
      var top = rowsFor('kungfus').slice(-3);
      if (top.length > 0) {
        top.forEach(function (row) {
          var id = rowId(row);
          if (!hero.kungfuSkills.some(function (skill) { return skill && Number(skill.skillID) === Number(id); })) {
            var idx = addKungFu(bundle, ref, id);
            hero.kungfuSkills[idx].lv = 10;
          }
        });
      }
      markHero(bundle, ref.file, ref.index);
    } else if (presetId === 'world_harmony') {
      var save = saveOf(bundle);
      hero.badFame = 0;
      hero.hp = hero.maxhp == null ? hero.hp : hero.maxhp;
      hero.power = hero.maxPower == null ? hero.power : hero.maxPower;
      hero.mana = hero.realMaxMana == null ? hero.mana : hero.realMaxMana;
      heroesOf(bundle, 'Hero').forEach(function (other, index) {
        if (other && other.heroID !== 0 &&
            (other.inTeam || (Array.isArray(hero.teamMates) && hero.teamMates.indexOf(other.heroID) >= 0) ||
             (Array.isArray(hero.Friends) && hero.Friends.indexOf(other.heroID) >= 0))) {
          other.favor = Math.max(100, Number(other.favor) || 0);
          markHero(bundle, 'Hero', index);
        }
      });
      save.totalBadFame = 0;
      save.cheating = false;
      save.cheated = false;
      markHero(bundle, ref.file, ref.index);
      markSave(bundle, 'totalBadFame');
      markSave(bundle, 'cheating');
      markSave(bundle, 'cheated');
    }
    return bundle;
  }

  function validateBundle(bundle) {
    var errors = [];
    var warnings = [];
    var info = bundle && bundle.data && bundle.data.Info;
    var summary = {
      slotVersion: info && info.SaveVersion ? info.SaveVersion : null,
      saveTime: info && info.SaveTime ? info.SaveTime : null,
      time: null,
      player: null,
      heroCounts: {},
      dirty: clone((bundle && bundle.dirty) || {})
    };
    try {
      var save = saveOf(bundle);
      summary.time = clone(save.worldTime || null);
      var ref = findPlayer(bundle, true);
      var hero = heroAt(bundle, ref);
      summary.player = {
        name: hero.heroName || hero.heroFamilyName || '',
        force: hero.belongForceID,
        money: hero.itemListData && hero.itemListData.money,
        area: hero.atAreaID
      };
      HERO_FILES.forEach(function (file) {
        var list = heroesOf(bundle, file);
        summary.heroCounts[file] = list.filter(Boolean).length;
        list.forEach(function (item, index) {
          if (item === null) return;
          [['baseAttri', 6], ['maxAttri', 6], ['baseFightSkill', 9], ['maxFightSkill', 9],
           ['baseLivingSkill', 9], ['maxLivingSkill', 9]].forEach(function (entry) {
            if (item[entry[0]] != null &&
                (!Array.isArray(item[entry[0]]) || item[entry[0]].length !== entry[1])) {
              warnings.push(file + ' ' + index + '번 영웅의 ' + entry[0] + ' 배열 길이가 올바르지 않습니다.');
            }
          });
        });
      });
    } catch (error) {
      errors.push(error && error.message ? error.message : '저장 자료를 확인할 수 없습니다.');
    }
    return { ok: errors.length === 0, errors: errors, warnings: warnings, summary: summary };
  }

  return {
    PRESETS: PRESETS,
    HERO_FILES: HERO_FILES.slice(),
    ATTR_LABELS: ATTR_LABELS.slice(),
    FIGHT_LABELS: FIGHT_LABELS.slice(),
    LIVING_LABELS: LIVING_LABELS.slice(),
    RESOURCE_LABELS: RESOURCE_LABELS.slice(),
    findPlayer: findPlayer,
    heroRef: heroRef,
    heroAt: heroAt,
    editHero: editHero,
    editHeroStat: editHeroStat,
    editKungFu: editKungFu,
    addKungFu: addKungFu,
    assignKungFu: assignKungFu,
    setAttackSkill: setAttackSkill,
    editTag: editTag,
    editInventory: editInventory,
    addItem: addItem,
    displayRelations: displayRelations,
    editRelation: editRelation,
    editWorld: editWorld,
    applyPreset: applyPreset,
    validateBundle: validateBundle,
    lookupCatalogName: lookupCatalogName
  };
});
