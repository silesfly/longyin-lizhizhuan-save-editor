(function () {
  'use strict';

  var DATA = window.LyzCatalogData || {};
  var Codec = window.LyzCodec || {};
  var Core = window.LyzCore || {};
  var FILES = ['Info', 'Save', 'Hero', 'TempHero'];
  var TABS = ['save', 'heroes', 'stats', 'skills', 'tags', 'inventory', 'world'];
  var PAGE_SIZE = 40;

  var state = {
    bundle: null,
    slot: '',
    tab: 'save',
    heroRef: null,
    page: 0,
    validation: null,
    nativeReady: false,
    serverReady: false,
    serverSlots: [],
    backups: []
  };

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var val = attrs[key];
        if (key === 'className') node.className = val;
        else if (key === 'text') node.textContent = val == null ? '' : String(val);
        else if (key === 'checked') node.checked = !!val;
        else if (key === 'disabled') node.disabled = !!val;
        else if (key === 'value') node.value = val == null ? '' : String(val);
        else if (key.slice(0, 2) === 'on' && typeof val === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), val);
        } else if (val !== false && val != null) {
          node.setAttribute(key, val === true ? '' : String(val));
        }
      });
    }
    var list = Array.isArray(children) ? children : (children == null ? [] : [children]);
    list.forEach(function (child) {
      if (child == null) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function toast(message, isError) {
    var box = $('#toast-box');
    if (!box) return;
    box.replaceChildren(el('div', {
      className: 'toast' + (isError ? ' error' : ''),
      text: String(message || '')
    }));
    box.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { box.hidden = true; }, 3500);
  }

  function setBadge(selector, text, good) {
    var node = $(selector);
    if (!node) return;
    node.textContent = text;
    node.classList.toggle('is-good', good === true);
    node.classList.toggle('is-bad', good === false);
  }

  function isDirty() {
    if (!state.bundle || !state.bundle.dirty) return false;
    return FILES.some(function (f) { return !!state.bundle.dirty[f]; });
  }

  function lookupName(kind, id, subType) {
    if (typeof Core.lookupCatalogName === 'function') {
      return Core.lookupCatalogName(kind, id, subType);
    }
    return '항목 #' + id;
  }

  function currentHero() {
    if (!state.bundle || !state.heroRef) return null;
    try {
      return Core.heroAt(state.bundle, state.heroRef);
    } catch (_) {
      return null;
    }
  }

  function loadRawFiles(rawFilesMap, label) {
    if (!rawFilesMap || typeof rawFilesMap !== 'object') return false;
    try {
      var prepared = {};
      FILES.forEach(function (name) {
        var entry = rawFilesMap[name];
        if (entry == null) {
          throw new Error(name + ' 파일이 누락되었습니다.');
        }
        if (typeof entry === 'string') {
          prepared[name] = { text: entry, isGzip: false, hasBom: false };
        } else if (entry && typeof entry.text === 'string') {
          prepared[name] = {
            text: entry.text,
            isGzip: !!entry.isGzip,
            hasBom: !!entry.hasBom
          };
        } else {
          prepared[name] = {
            text: JSON.stringify(entry),
            isGzip: false,
            hasBom: false
          };
        }
      });
      state.bundle = Codec.createBundle(prepared);
      state.slot = label || '불러온 슬롯';
      state.page = 0;
      state.validation = Core.validateBundle(state.bundle);
      state.heroRef = Core.findPlayer(state.bundle, false);
      if (!state.heroRef && state.bundle.data.Hero) {
        for (var i = 0; i < state.bundle.data.Hero.length; i++) {
          if (state.bundle.data.Hero[i]) {
            state.heroRef = Core.heroRef(state.bundle, 'Hero', i);
            break;
          }
        }
      }
      renderAll();
      toast('슬롯을 불러왔습니다: ' + state.slot);
      return true;
    } catch (err) {
      toast(err && err.message ? err.message : '슬롯을 불러오지 못했습니다.', true);
      return false;
    }
  }

  function buildDemoSlot() {
    var demoInfo = {
      SaveVersion: '1.1.3 f0',
      SaveDetail: '선하파\n2년 3월 16일\n스토리 모드\n입문 제자',
      SaveTime: '2026-11-20 01:00:00'
    };
    var demoSave = {
      chapter: 1,
      gameMode: 0,
      gameDifficulty: 2,
      relaxMode: false,
      worldTime: { year: 2, month: 3, day: 16 },
      hour: 12.5,
      speEnhanceStone: 15,
      cheating: false,
      cheated: false,
      totalFightCount: 24,
      totalWinFightCount: 22,
      totalEnemyKilled: 18,
      totalBadFame: 0,
      Forces: [
        { forceID: 0, forceName: '장락방', forceLv: 3, resourceStore: [5000, 1200, 800, 600, 400] },
        { forceID: 25, forceName: '선하파', forceLv: 4, resourceStore: [12000, 3000, 2000, 1500, 900] }
      ],
      Areas: [
        { areaID: 0, areaName: '경성', people: 2800, maxPeople: 3000, safe: 92, support: 90, defence: 95, belongForceID: 4 },
        { areaID: 8, areaName: '강릉', people: 1850, maxPeople: 2200, safe: 86, support: 88, defence: 80, belongForceID: 25 }
      ]
    };
    var demoPlayer = {
      heroID: 0,
      heroFamilyName: '강',
      heroName: '용운',
      heroNickName: '청운검객',
      isFemale: false,
      age: 19,
      belongForceID: 25,
      heroForceLv: 2,
      atAreaID: 8,
      fame: 1500,
      badFame: 0,
      loyal: 95,
      favor: 0,
      hp: 620,
      maxhp: 620,
      realMaxHp: 620,
      power: 120,
      maxPower: 120,
      realMaxPower: 120,
      mana: 980,
      maxMana: 980,
      realMaxMana: 980,
      armor: 45,
      externalInjury: 0,
      internalInjury: 0,
      poisonInjury: 0,
      heroTagPoint: 200,
      baseAttri: [55, 62, 48, 50, 54, 60],
      maxAttri: [85, 90, 80, 85, 88, 90],
      baseFightSkill: [70, 64, 52, 45, 78, 35, 30, 28, 25],
      maxFightSkill: [95, 90, 85, 80, 98, 75, 70, 70, 70],
      baseLivingSkill: [48, 20, 65, 52, 30, 32, 40, 44, 38],
      maxLivingSkill: [85, 70, 90, 85, 75, 75, 80, 85, 80],
      kungfuSkills: [
        { skillID: 0, lv: 8, fightExp: 120, bookExp: 80, equiped: true, belongHeroID: 0 },
        { skillID: 1, lv: 6, fightExp: 40, bookExp: 20, equiped: true, belongHeroID: 0 }
      ],
      internalSkillSaveRecord: 0,
      dodgeSkillSaveRecord: 1,
      uniqueSkillSaveRecord: 0,
      attackSkillSaveRecord: [0, 1, -1, -1, -1, -1, -1, -1],
      heroTagData: [
        { tagID: 0, leftTime: -1, sourceHero: null }
      ],
      itemListData: {
        money: 12500,
        maxWeight: 520,
        allItem: [
          { itemID: 0, type: 0, subType: 0, name: '수갑', value: 250, itemLv: 1, rareLv: 1, weight: 3, poisonNum: 0, equipmentData: { enhanceLv: 1, littleType: 0, equiped: true } },
          { itemID: 0, type: 1, subType: 0, name: '보혈단', value: 45, itemLv: 1, rareLv: 2, weight: 1, poisonNum: 0, medFoodData: { enhanceLv: 0 } }
        ]
      },
      nowEquipment: {
        weaponSaveRecord: [0],
        armorSaveRecord: [],
        helmetSaveRecord: [],
        shoesSaveRecord: [],
        decorationSaveRecord: []
      },
      horseSaveRecord: -1,
      horseArmorSaveRecord: -1,
      inTeam: false,
      teamMates: [1],
      Lover: -1,
      Brothers: [],
      Friends: [1],
      Haters: []
    };
    var demoAlly = {
      heroID: 1,
      heroFamilyName: '강',
      heroName: '영천',
      heroNickName: '선하장문',
      isFemale: false,
      age: 38,
      belongForceID: 25,
      heroForceLv: 5,
      atAreaID: 8,
      fame: 4800,
      badFame: 0,
      loyal: 100,
      favor: 85,
      hp: 950,
      maxhp: 950,
      realMaxHp: 950,
      power: 160,
      maxPower: 160,
      realMaxPower: 160,
      mana: 1600,
      maxMana: 1600,
      realMaxMana: 1600,
      armor: 80,
      externalInjury: 0,
      internalInjury: 0,
      poisonInjury: 0,
      heroTagPoint: 100,
      baseAttri: [68, 72, 66, 70, 74, 75],
      maxAttri: [95, 95, 90, 95, 95, 95],
      baseFightSkill: [85, 76, 70, 62, 92, 48, 45, 50, 40],
      maxFightSkill: [100, 95, 90, 88, 100, 80, 80, 80, 75],
      baseLivingSkill: [72, 35, 78, 42, 40, 45, 50, 55, 48],
      maxLivingSkill: [95, 80, 95, 80, 80, 80, 85, 85, 85],
      kungfuSkills: [{ skillID: 0, lv: 10, fightExp: 0, bookExp: 0, equiped: true, belongHeroID: 1 }],
      internalSkillSaveRecord: 0,
      dodgeSkillSaveRecord: 0,
      uniqueSkillSaveRecord: 0,
      attackSkillSaveRecord: [0, -1, -1, -1, -1, -1, -1, -1],
      heroTagData: [{ tagID: 1, leftTime: -1, sourceHero: null }],
      itemListData: { money: 3200, maxWeight: 600, allItem: [] },
      nowEquipment: { weaponSaveRecord: [], armorSaveRecord: [], helmetSaveRecord: [], shoesSaveRecord: [], decorationSaveRecord: [] },
      horseSaveRecord: -1,
      horseArmorSaveRecord: -1,
      inTeam: true,
      teamMates: [],
      Lover: -1,
      Brothers: [],
      Friends: [0],
      Haters: []
    };
    return {
      Info: { text: JSON.stringify(demoInfo), isGzip: false, hasBom: false },
      Save: { text: JSON.stringify(demoSave), isGzip: false, hasBom: false },
      Hero: { text: JSON.stringify([demoPlayer, demoAlly, null]), isGzip: false, hasBom: false },
      TempHero: { text: JSON.stringify([]), isGzip: false, hasBom: false }
    };
  }

  function loadDemoSlot() {
    return loadRawFiles(buildDemoSlot(), '예시 슬롯 (Demo)');
  }

  function serializeFiles() {
    if (!state.bundle) return {};
    return Codec.serializeBundle(state.bundle);
  }

  function getState() {
    var hero = currentHero();
    return {
      slot: state.slot,
      tab: state.tab,
      dirty: isDirty(),
      heroRef: state.heroRef ? { file: state.heroRef.file, index: state.heroRef.index, heroID: state.heroRef.heroID } : null,
      playerName: hero ? (hero.heroName || '') : '',
      validation: state.validation,
      nativeReady: state.nativeReady,
      serverReady: state.serverReady
    };
  }

  function selectTab(name) {
    if (TABS.indexOf(name) < 0) return false;
    state.tab = name;
    $$('[role="tab"][data-tab]').forEach(function (tab) {
      var selected = tab.getAttribute('data-tab') === name;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
    });
    $$('[role="tabpanel"][data-panel]').forEach(function (panel) {
      var active = panel.getAttribute('data-panel') === name;
      panel.classList.toggle('active', active);
      panel.hidden = !active;
    });
    return true;
  }

  function selectHero(file, index) {
    if (!state.bundle) return false;
    try {
      state.heroRef = Core.heroRef(state.bundle, file, index);
      renderHeroTabs();
      return true;
    } catch (_) {
      return false;
    }
  }

  function afterMutation() {
    if (state.bundle) {
      state.validation = Core.validateBundle(state.bundle);
    }
    renderSummary();
  }

  function renderSummary() {
    var summaryHost = $('#slot-summary');
    var tableBody = $('#file-status-table tbody');
    if (!state.bundle) {
      if (summaryHost) {
        summaryHost.replaceChildren(el('div', { className: 'empty-state', text: '저장 파일을 열면 요약 정보가 표시됩니다.' }));
      }
      if (tableBody) {
        tableBody.replaceChildren(el('tr', {}, el('td', { colspan: '4', text: '파일 정보가 없습니다.' })));
      }
      setBadge('#validation-badge', '검증 대기', null);
      return;
    }

    var v = state.validation || Core.validateBundle(state.bundle);
    state.validation = v;
    setBadge('#validation-badge', v.ok ? '검증 통과' : '오류 ' + v.errors.length + '건', v.ok);

    if (summaryHost) {
      var s = v.summary || {};
      var player = s.player || {};
      var timeText = s.time ? (s.time.year + '년 ' + s.time.month + '월 ' + s.time.day + '일') : '-';
      summaryHost.replaceChildren(
        el('div', { className: 'field-grid' }, [
          el('div', {}, [el('strong', { text: '슬롯: ' }), el('span', { text: state.slot })]),
          el('div', {}, [el('strong', { text: '게임 버전: ' }), el('span', { text: s.slotVersion || '-' })]),
          el('div', {}, [el('strong', { text: '저장 시각: ' }), el('span', { text: s.saveTime || '-' })]),
          el('div', {}, [el('strong', { text: '세계 날짜: ' }), el('span', { text: timeText })]),
          el('div', {}, [el('strong', { text: '주인공: ' }), el('span', { text: player.name || '-' })]),
          el('div', {}, [el('strong', { text: '소속 문파: ' }), el('span', { text: player.force != null ? lookupName('forces', player.force) : '-' })]),
          el('div', {}, [el('strong', { text: '보유 은전: ' }), el('span', { text: player.money != null ? String(player.money) : '-' })]),
          el('div', {}, [el('strong', { text: '인물 수: ' }), el('span', { text: '고정 ' + (s.heroCounts.Hero || 0) + ' / 임시 ' + (s.heroCounts.TempHero || 0) })])
        ])
      );
    }

    if (tableBody) {
      tableBody.replaceChildren();
      FILES.forEach(function (name) {
        var meta = (state.bundle.meta.files && state.bundle.meta.files[name]) || {};
        var dirty = !!(state.bundle.dirty && state.bundle.dirty[name]);
        var gzBox = el('input', {
          type: 'checkbox',
          checked: !!meta.isGzip,
          'aria-label': name + ' GZip 압축 여부',
          onChange: function () {
            meta.isGzip = gzBox.checked;
            toast(name + ' 저장 형식을 ' + (meta.isGzip ? 'GZip 압축' : '평문 UTF-8') + '으로 변경했습니다.');
          }
        });
        tableBody.appendChild(el('tr', {}, [
          el('th', { scope: 'row', text: name }),
          el('td', { text: state.bundle.data[name] !== undefined ? '불러옴' : '없음' }),
          el('td', {}, gzBox),
          el('td', { text: dirty ? '수정됨' : '원본 유지' })
        ]));
      });
    }
  }

  function allHeroItems() {
    if (!state.bundle) return [];
    var filter = ($('#hero-file-filter') || {}).value || '';
    var search = (($('#hero-search') || {}).value || '').trim().toLowerCase();
    var teamOnly = !!($('#hero-team-only') || {}).checked;
    var rows = [];
    Core.HERO_FILES.forEach(function (file) {
      if (filter && filter !== file) return;
      var list = state.bundle.data[file];
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i++) {
        var h = list[i];
        if (!h) continue;
        if (teamOnly && !h.inTeam && h.heroID !== 0) continue;
        var fullName = h.heroName || h.heroFamilyName || ('영웅 #' + h.heroID);
        if (search && fullName.toLowerCase().indexOf(search) < 0 && String(h.heroID).indexOf(search) < 0) {
          continue;
        }
        rows.push({ file: file, index: i, hero: h, name: fullName });
      }
    });
    return rows;
  }

  function renderHeroesList() {
    var tbody = $('#hero-list-tbody');
    var pager = $('#hero-pager');
    if (!tbody) return;
    tbody.replaceChildren();
    var items = allHeroItems();
    var pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages - 1);
    var slice = items.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);

    slice.forEach(function (item) {
      var selected = state.heroRef && state.heroRef.file === item.file && state.heroRef.index === item.index;
      var forceLabel = item.hero.belongForceID >= 0 ? lookupName('forces', item.hero.belongForceID) : '무소속';
      var tr = el('tr', {
        className: 'clickable' + (selected ? ' is-selected' : ''),
        tabindex: '0',
        onClick: function () { selectHero(item.file, item.index); },
        onKeydown: function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectHero(item.file, item.index);
          }
        }
      }, [
        el('td', { text: item.name + ' (#' + item.hero.heroID + ')' }),
        el('td', { text: forceLabel + ' · ' + item.file })
      ]);
      tbody.appendChild(tr);
    });

    if (!slice.length) {
      tbody.appendChild(el('tr', {}, el('td', { colspan: '2', text: '조건에 맞는 인물이 없습니다.' })));
    }

    if (pager) {
      pager.replaceChildren(
        el('span', { text: (state.page + 1) + ' / ' + pages + ' 페이지 (총 ' + items.length + '명)' }),
        el('div', { className: 'button-row' }, [
          el('button', {
            type: 'button', text: '이전', disabled: state.page === 0,
            onClick: function () { state.page--; renderHeroesList(); }
          }),
          el('button', {
            type: 'button', text: '다음', disabled: state.page >= pages - 1,
            onClick: function () { state.page++; renderHeroesList(); }
          })
        ])
      );
    }
  }

  function makeNumberField(labelText, val, onApply, min, max, step) {
    var input = el('input', {
      type: 'number',
      value: val == null ? 0 : val,
      min: min,
      max: max,
      step: step || 'any'
    });
    input.addEventListener('change', function () {
      try {
        onApply(Number(input.value));
        afterMutation();
      } catch (err) {
        toast(err.message, true);
      }
    });
    return el('label', { text: labelText }, input);
  }

  function makeTextField(labelText, val, onApply) {
    var input = el('input', { type: 'text', value: val || '' });
    input.addEventListener('change', function () {
      try {
        onApply(input.value);
        afterMutation();
      } catch (err) {
        toast(err.message, true);
      }
    });
    return el('label', { text: labelText }, input);
  }

  function makeSelectField(labelText, options, currentVal, onApply) {
    var sel = el('select', {}, options.map(function (opt) {
      return el('option', { value: opt.value, text: opt.label });
    }));
    sel.value = String(currentVal);
    sel.addEventListener('change', function () {
      try {
        onApply(sel.value);
        afterMutation();
      } catch (err) {
        toast(err.message, true);
      }
    });
    return el('label', { text: labelText }, sel);
  }

  function renderHeroDetail() {
    var host = $('#hero-detail-form');
    if (!host) return;
    var hero = currentHero();
    if (!hero) {
      host.replaceChildren(el('div', { className: 'empty-state', text: '목록에서 인물을 선택하세요.' }));
      return;
    }

    var forceOpts = [{ value: '-1', label: '무소속 (-1)' }].concat((DATA.forces || []).map(function (f) {
      return { value: String(f.id), label: f.name + ' (#' + f.id + ')' };
    }));
    var areaOpts = (DATA.areas || []).map(function (a) {
      return { value: String(a.id), label: a.name + ' (#' + a.id + ')' };
    });
    var ref = state.heroRef;

    host.replaceChildren(
      el('div', { className: 'field-grid' }, [
        makeTextField('성(Family)', hero.heroFamilyName, function (v) { Core.editHero(state.bundle, ref, 'heroFamilyName', v); renderHeroesList(); }),
        makeTextField('이름(Name)', hero.heroName, function (v) { Core.editHero(state.bundle, ref, 'heroName', v); renderHeroesList(); }),
        makeTextField('별호(Nick)', hero.heroNickName, function (v) { Core.editHero(state.bundle, ref, 'heroNickName', v); }),
        makeSelectField('성별', [{ value: 'false', label: '남성' }, { value: 'true', label: '여성' }], !!hero.isFemale, function (v) { Core.editHero(state.bundle, ref, 'isFemale', v === 'true'); }),
        makeNumberField('나이', hero.age, function (v) { Core.editHero(state.bundle, ref, 'age', v); }, 1, 200, 1),
        makeSelectField('소속 문파', forceOpts, hero.belongForceID, function (v) { Core.editHero(state.bundle, ref, 'belongForceID', Number(v)); renderHeroesList(); }),
        makeNumberField('문파 직위 등급', hero.heroForceLv, function (v) { Core.editHero(state.bundle, ref, 'heroForceLv', v); }, 0, 10, 1),
        makeSelectField('현재 거점', areaOpts, hero.atAreaID, function (v) { Core.editHero(state.bundle, ref, 'atAreaID', Number(v)); }),
        makeNumberField('명성', hero.fame, function (v) { Core.editHero(state.bundle, ref, 'fame', v); }),
        makeNumberField('악명', hero.badFame, function (v) { Core.editHero(state.bundle, ref, 'badFame', v); }, 0),
        makeNumberField('충성도', hero.loyal, function (v) { Core.editHero(state.bundle, ref, 'loyal', v); }, 0, 100),
        makeNumberField('호감도', hero.favor, function (v) { Core.editHero(state.bundle, ref, 'favor', v); }),
        makeNumberField('특성 포인트', hero.heroTagPoint, function (v) { Core.editHero(state.bundle, ref, 'heroTagPoint', v); }, 0)
      ])
    );
  }

  function renderStatsTab() {
    var host = $('#stats-detail');
    if (!host) return;
    var hero = currentHero();
    if (!hero) {
      host.replaceChildren(el('div', { className: 'empty-state', text: '인물을 선택하면 능력 편집 항목이 표시됩니다.' }));
      return;
    }
    var ref = state.heroRef;

    function buildArraySection(title, baseKey, maxKey, labels) {
      var baseArr = hero[baseKey] || [];
      var maxArr = hero[maxKey] || [];
      var grid = el('div', { className: 'field-grid' });
      labels.forEach(function (lbl, idx) {
        grid.appendChild(makeNumberField(lbl + ' (기본)', baseArr[idx], function (v) { Core.editHeroStat(state.bundle, ref, baseKey, idx, v); }, 0));
        grid.appendChild(makeNumberField(lbl + ' (상한)', maxArr[idx], function (v) { Core.editHeroStat(state.bundle, ref, maxKey, idx, v); }, 0));
      });
      return el('div', { className: 'sub-section' }, [el('h4', { text: title }), grid]);
    }

    host.replaceChildren(
      el('div', { className: 'button-row', style: 'margin-bottom: 14px' }, [
        el('button', {
          type: 'button', className: 'primary', text: '생명·기력·내력 완치',
          onClick: function () {
            Core.editHero(state.bundle, ref, 'externalInjury', 0);
            Core.editHero(state.bundle, ref, 'internalInjury', 0);
            Core.editHero(state.bundle, ref, 'poisonInjury', 0);
            if (hero.maxhp != null) Core.editHero(state.bundle, ref, 'hp', hero.maxhp);
            if (hero.maxPower != null) Core.editHero(state.bundle, ref, 'power', hero.maxPower);
            if (hero.realMaxMana != null) Core.editHero(state.bundle, ref, 'mana', hero.realMaxMana);
            afterMutation();
            renderStatsTab();
            toast('인물 상태를 완치했습니다.');
          }
        })
      ]),
      el('div', { className: 'field-grid' }, [
        makeNumberField('현재 생명', hero.hp, function (v) { Core.editHero(state.bundle, ref, 'hp', v); }, 0),
        makeNumberField('최대 생명', hero.maxhp, function (v) { Core.editHero(state.bundle, ref, 'maxhp', v); }, 0),
        makeNumberField('실제 상한 생명', hero.realMaxHp, function (v) { Core.editHero(state.bundle, ref, 'realMaxHp', v); }, 0),
        makeNumberField('현재 기력', hero.power, function (v) { Core.editHero(state.bundle, ref, 'power', v); }, 0),
        makeNumberField('최대 기력', hero.maxPower, function (v) { Core.editHero(state.bundle, ref, 'maxPower', v); }, 0),
        makeNumberField('현재 내력', hero.mana, function (v) { Core.editHero(state.bundle, ref, 'mana', v); }, 0),
        makeNumberField('최대 내력', hero.maxMana, function (v) { Core.editHero(state.bundle, ref, 'maxMana', v); }, 0),
        makeNumberField('방어력', hero.armor, function (v) { Core.editHero(state.bundle, ref, 'armor', v); }, 0),
        makeNumberField('외상', hero.externalInjury, function (v) { Core.editHero(state.bundle, ref, 'externalInjury', v); }, 0),
        makeNumberField('내상', hero.internalInjury, function (v) { Core.editHero(state.bundle, ref, 'internalInjury', v); }, 0),
        makeNumberField('중독', hero.poisonInjury, function (v) { Core.editHero(state.bundle, ref, 'poisonInjury', v); }, 0)
      ]),
      buildArraySection('기본 속성 (6종)', 'baseAttri', 'maxAttri', Core.ATTR_LABELS),
      buildArraySection('전투 숙련 (9종)', 'baseFightSkill', 'maxFightSkill', Core.FIGHT_LABELS),
      buildArraySection('생활 숙련 (9종)', 'baseLivingSkill', 'maxLivingSkill', Core.LIVING_LABELS)
    );
  }

  function renderSkillsTab() {
    var host = $('#skills-detail');
    if (!host) return;
    var hero = currentHero();
    if (!hero) {
      host.replaceChildren(el('div', { className: 'empty-state', text: '인물을 선택하면 무공 정보가 표시됩니다.' }));
      return;
    }
    var ref = state.heroRef;
    var skills = Array.isArray(hero.kungfuSkills) ? hero.kungfuSkills : [];
    var skillOptions = [{ value: '-1', label: '미장착 (-1)' }].concat(skills.map(function (sk, idx) {
      return { value: String(idx), label: '[' + idx + '] ' + lookupName('kungfus', sk.skillID) + ' (' + sk.lv + '성)' };
    }));

    var slotGrid = el('div', { className: 'field-grid' }, [
      makeSelectField('주운 내공', skillOptions.slice(1), hero.internalSkillSaveRecord, function (v) { Core.assignKungFu(state.bundle, ref, 'internal', Number(v)); renderSkillsTab(); }),
      makeSelectField('주운 경공', skillOptions.slice(1), hero.dodgeSkillSaveRecord, function (v) { Core.assignKungFu(state.bundle, ref, 'dodge', Number(v)); renderSkillsTab(); }),
      makeSelectField('장착 절기', skillOptions.slice(1), hero.uniqueSkillSaveRecord, function (v) { Core.assignKungFu(state.bundle, ref, 'unique', Number(v)); renderSkillsTab(); })
    ]);
    var atk = Array.isArray(hero.attackSkillSaveRecord) ? hero.attackSkillSaveRecord : [];
    for (var s = 0; s < Math.min(8, atk.length); s++) {
      (function (slotIdx) {
        slotGrid.appendChild(makeSelectField('외공 슬롯 ' + (slotIdx + 1), skillOptions, atk[slotIdx], function (v) {
          Core.setAttackSkill(state.bundle, ref, slotIdx, Number(v));
          renderSkillsTab();
        }));
      }(s));
    }

    var addSearch = el('input', { type: 'search', placeholder: '추가할 무공 이름 검색' });
    var addSel = el('select', {});
    function fillSkillCatalog() {
      var q = addSearch.value.trim().toLowerCase();
      addSel.replaceChildren();
      (DATA.kungfus || []).filter(function (k) {
        return !q || k.name.toLowerCase().indexOf(q) >= 0 || String(k.id).indexOf(q) >= 0;
      }).slice(0, 120).forEach(function (k) {
        addSel.appendChild(el('option', { value: String(k.id), text: k.name + ' (' + k.category + ' · #' + k.id + ')' }));
      });
    }
    addSearch.addEventListener('input', fillSkillCatalog);
    fillSkillCatalog();

    var tbody = el('tbody', {});
    skills.forEach(function (sk, idx) {
      if (!sk) return;
      var lvInput = el('input', { type: 'number', min: 1, max: 10, value: sk.lv });
      lvInput.addEventListener('change', function () {
        try {
          Core.editKungFu(state.bundle, ref, idx, { lv: Number(lvInput.value) });
          afterMutation();
        } catch (err) { toast(err.message, true); }
      });
      tbody.appendChild(el('tr', {}, [
        el('td', { text: String(idx) }),
        el('td', { text: lookupName('kungfus', sk.skillID) + ' (#' + sk.skillID + ')' }),
        el('td', {}, lvInput),
        el('td', { text: sk.equiped ? '장착 중' : '보유' })
      ]));
    });

    host.replaceChildren(
      el('div', { className: 'sub-section', style: 'margin-top:0;border-top:0;padding-top:0' }, [
        el('h4', { text: '무공 슬롯 장착' }),
        slotGrid
      ]),
      el('div', { className: 'sub-section' }, [
        el('h4', { text: '카탈로그에서 무공 추가' }),
        el('div', { className: 'field-grid' }, [
          el('label', { text: '무공 검색' }, addSearch),
          el('label', { text: '선택' }, addSel)
        ]),
        el('div', { className: 'button-row', style: 'margin-top:10px' }, [
          el('button', {
            type: 'button', className: 'primary', text: '무공 추가',
            onClick: function () {
              if (!addSel.value) return;
              try {
                Core.addKungFu(state.bundle, ref, Number(addSel.value));
                afterMutation();
                renderSkillsTab();
                toast('무공을 추가했습니다.');
              } catch (err) { toast(err.message, true); }
            }
          })
        ])
      ]),
      el('div', { className: 'sub-section' }, [
        el('h4', { text: '습득 무공 목록 (' + skills.length + '종)' }),
        el('div', { className: 'table-wrap' }, el('table', {}, [
          el('thead', {}, el('tr', {}, [el('th', { text: '순번' }), el('th', { text: '무공' }), el('th', { text: '단계(1~10)' }), el('th', { text: '상태' })])),
          tbody
        ]))
      ])
    );
  }

  function renderTagsTab() {
    var host = $('#tags-detail');
    if (!host) return;
    var hero = currentHero();
    if (!hero) {
      host.replaceChildren(el('div', { className: 'empty-state', text: '인물을 선택하면 특성과 관계가 표시됩니다.' }));
      return;
    }
    var ref = state.heroRef;
    var tags = Array.isArray(hero.heroTagData) ? hero.heroTagData : [];

    var tagSearch = el('input', { type: 'search', placeholder: '특성 검색' });
    var tagSel = el('select', {});
    function fillTags() {
      var q = tagSearch.value.trim().toLowerCase();
      tagSel.replaceChildren();
      (DATA.tags || []).filter(function (t) {
        return !q || t.name.toLowerCase().indexOf(q) >= 0 || String(t.id).indexOf(q) >= 0;
      }).slice(0, 120).forEach(function (t) {
        tagSel.appendChild(el('option', { value: String(t.id), text: t.name + ' (' + t.category + ' · #' + t.id + ')' }));
      });
    }
    tagSearch.addEventListener('input', fillTags);
    fillTags();

    var tbody = el('tbody', {});
    tags.forEach(function (tg, idx) {
      tbody.appendChild(el('tr', {}, [
        el('td', { text: lookupName('tags', tg.tagID) + ' (#' + tg.tagID + ')' }),
        el('td', { text: tg.leftTime < 0 ? '영구' : (tg.leftTime + '일') }),
        el('td', {}, el('div', { className: 'button-row' }, [
          el('button', {
            type: 'button', text: tg.leftTime < 0 ? '기한제로' : '영구화',
            onClick: function () {
              Core.editTag(state.bundle, ref, 'permanent', idx, tg.leftTime >= 0);
              afterMutation();
              renderTagsTab();
            }
          }),
          el('button', {
            type: 'button', className: 'danger', text: '제거',
            onClick: function () {
              Core.editTag(state.bundle, ref, 'remove', idx);
              afterMutation();
              renderTagsTab();
            }
          })
        ]))
      ]));
    });

    var rel = Core.displayRelations(state.bundle, hero);
    function relText(key) {
      var val = rel[key];
      if (Array.isArray(val)) return val.length ? val.map(function (r) { return r.name + '(#' + r.heroID + ')'; }).join(', ') : '없음';
      if (val && typeof val === 'object') return val.name + (val.heroID >= 0 ? ' (#' + val.heroID + ')' : '');
      return String(val);
    }

    host.replaceChildren(
      el('div', { className: 'sub-section', style: 'margin-top:0;border-top:0;padding-top:0' }, [
        el('h4', { text: '특성 추가' }),
        el('div', { className: 'field-grid' }, [el('label', { text: '검색' }, tagSearch), el('label', { text: '특성' }, tagSel)]),
        el('div', { className: 'button-row', style: 'margin-top:10px' }, [
          el('button', {
            type: 'button', className: 'primary', text: '영구 특성 추가',
            onClick: function () {
              if (!tagSel.value) return;
              Core.editTag(state.bundle, ref, 'add', null, { tagID: Number(tagSel.value), permanent: true });
              afterMutation();
              renderTagsTab();
              toast('특성을 추가했습니다.');
            }
          })
        ])
      ]),
      el('div', { className: 'sub-section' }, [
        el('h4', { text: '보유 특성 (' + tags.length + '종)' }),
        el('div', { className: 'table-wrap' }, el('table', {}, [
          el('thead', {}, el('tr', {}, [el('th', { text: '특성' }), el('th', { text: '기한' }), el('th', { text: '관리' })])),
          tbody
        ]))
      ]),
      el('div', { className: 'sub-section' }, [
        el('h4', { text: '인물 관계' }),
        el('div', { className: 'field-grid' }, [
          makeSelectField('동료 편성 여부', [{ value: 'false', label: '비편성' }, { value: 'true', label: '동행 중' }], !!hero.inTeam, function (v) { Core.editRelation(state.bundle, ref, 'inTeam', v === 'true'); renderHeroesList(); }),
          el('div', {}, [el('strong', { text: '현재 동행: ' }), el('span', { text: relText('teamMates') })]),
          el('div', {}, [el('strong', { text: '연인: ' }), el('span', { text: relText('Lover') })]),
          el('div', {}, [el('strong', { text: '의형제: ' }), el('span', { text: relText('Brothers') })]),
          el('div', {}, [el('strong', { text: '친구: ' }), el('span', { text: relText('Friends') })]),
          el('div', {}, [el('strong', { text: '원수: ' }), el('span', { text: relText('Haters') })])
        ])
      ])
    );
  }

  function renderInventoryTab() {
    var host = $('#inventory-detail');
    if (!host) return;
    var hero = currentHero();
    if (!hero || !hero.itemListData) {
      host.replaceChildren(el('div', { className: 'empty-state', text: '소지품 자료가 있는 인물을 선택하세요.' }));
      return;
    }
    var ref = state.heroRef;
    var inv = hero.itemListData;
    var allItems = Array.isArray(inv.allItem) ? inv.allItem : [];
    var typeNames = (DATA.enums && DATA.enums.itemTypes) || {};

    var catSel = el('select', {}, [
      el('option', { value: '3:0', text: '무공 비급' }),
      el('option', { value: '1:0', text: '단약' }),
      el('option', { value: '2:0', text: '음식/술' }),
      el('option', { value: '6:0', text: '명마' }),
      el('option', { value: '0:0', text: '무기' }),
      el('option', { value: '0:1', text: '갑옷' }),
      el('option', { value: '0:2', text: '모자/투구' }),
      el('option', { value: '0:3', text: '신발' })
    ]);
    var itemSel = el('select', {});
    function fillItemCatalog() {
      itemSel.replaceChildren();
      var parts = catSel.value.split(':');
      var t = Number(parts[0]);
      var st = Number(parts[1]);
      var rows = [];
      if (t === 3) rows = DATA.kungfus || [];
      else if (t === 1) rows = DATA.meds || [];
      else if (t === 2) rows = DATA.foods || [];
      else if (t === 6) rows = DATA.horses || [];
      else if (t === 0 && st === 0) rows = DATA.weapons || [];
      else if (t === 0) rows = (DATA.armors || []).filter(function (a) { return a.subType === st; });
      rows.slice(0, 150).forEach(function (r) {
        itemSel.appendChild(el('option', { value: String(r.id), text: r.name + ' (#' + r.id + ')' }));
      });
    }
    catSel.addEventListener('change', fillItemCatalog);
    fillItemCatalog();

    var tbody = el('tbody', {});
    allItems.slice(0, 150).forEach(function (it, idx) {
      if (!it) return;
      var rareSel = el('select', {}, ((DATA.enums && DATA.enums.rareLevels) || ['평범', '우수', '정교', '희귀', '전설', '절세']).map(function (lbl, rIdx) {
        return el('option', { value: String(rIdx), text: lbl });
      }));
      rareSel.value = String(it.rareLv || 0);
      rareSel.addEventListener('change', function () {
        Core.editInventory(state.bundle, ref, 'item', { index: idx, field: 'rareLv', value: Number(rareSel.value) });
        afterMutation();
      });
      var labelName = it.name || ('항목 #' + it.itemID);
      if (it.type === 3 && it.bookData) {
        labelName = lookupName('kungfus', it.bookData.skillID) + ' 비급';
      }
      tbody.appendChild(el('tr', {}, [
        el('td', { text: String(idx) }),
        el('td', { text: typeNames[String(it.type)] || ('분류 ' + it.type) }),
        el('td', { text: labelName }),
        el('td', {}, rareSel),
        el('td', { text: String(it.value || 0) })
      ]));
    });

    host.replaceChildren(
      el('div', { className: 'field-grid' }, [
        makeNumberField('보유 은전', inv.money, function (v) { Core.editInventory(state.bundle, ref, 'money', v); }, 0, null, 1),
        makeNumberField('적재 중량 상한', inv.maxWeight, function (v) { Core.editInventory(state.bundle, ref, 'maxWeight', v); }, 0)
      ]),
      el('div', { className: 'sub-section' }, [
        el('h4', { text: '카탈로그에서 소지품 추가' }),
        el('div', { className: 'field-grid' }, [el('label', { text: '분류' }, catSel), el('label', { text: '품목' }, itemSel)]),
        el('div', { className: 'button-row', style: 'margin-top:10px' }, [
          el('button', {
            type: 'button', className: 'primary', text: '소지품 추가',
            onClick: function () {
              if (!itemSel.value) return;
              var parts = catSel.value.split(':');
              Core.addItem(state.bundle, ref, Number(parts[0]), Number(parts[1]), Number(itemSel.value));
              afterMutation();
              renderInventoryTab();
              toast('소지품을 추가했습니다.');
            }
          })
        ])
      ]),
      el('div', { className: 'sub-section' }, [
        el('h4', { text: '소지품 목록 (' + allItems.length + '개, 상위 150개 표시)' }),
        el('div', { className: 'table-wrap' }, el('table', {}, [
          el('thead', {}, el('tr', {}, [el('th', { text: '순번' }), el('th', { text: '분류' }), el('th', { text: '품명' }), el('th', { text: '등급' }), el('th', { text: '가치' })])),
          tbody
        ]))
      ])
    );
  }

  function renderWorldTab() {
    var presetBar = $('#preset-bar');
    var host = $('#world-detail');
    if (presetBar) {
      presetBar.replaceChildren();
      Object.keys(Core.PRESETS).forEach(function (pid) {
        presetBar.appendChild(el('button', {
          type: 'button',
          text: Core.PRESETS[pid].name,
          disabled: !state.bundle,
          onClick: function () {
            try {
              Core.applyPreset(state.bundle, pid);
              afterMutation();
              renderHeroTabs();
              renderWorldTab();
              toast(Core.PRESETS[pid].name + ' 프리셋을 적용했습니다.');
            } catch (err) { toast(err.message, true); }
          }
        }));
      });
    }
    if (!host) return;
    if (!state.bundle || !state.bundle.data.Save) {
      host.replaceChildren(el('div', { className: 'empty-state', text: '저장 파일을 열면 세계 정보가 표시됩니다.' }));
      return;
    }
    var save = state.bundle.data.Save;
    var wt = save.worldTime || { year: 1, month: 1, day: 1 };
    var forcesBody = el('tbody', {});
    (save.Forces || []).forEach(function (f, idx) {
      var lvInput = el('input', { type: 'number', min: 0, max: 10, value: f.forceLv });
      lvInput.addEventListener('change', function () {
        Core.editWorld(state.bundle, 'Forces', Number(lvInput.value), idx, 'forceLv');
        afterMutation();
      });
      var silInput = el('input', { type: 'number', min: 0, value: (f.resourceStore && f.resourceStore[0]) || 0 });
      silInput.addEventListener('change', function () {
        Core.editWorld(state.bundle, 'Forces', { index: 0, value: Number(silInput.value) }, idx, 'resourceStore');
        afterMutation();
      });
      forcesBody.appendChild(el('tr', {}, [
        el('td', { text: lookupName('forces', f.forceID) + ' (#' + f.forceID + ')' }),
        el('td', {}, lvInput),
        el('td', {}, silInput)
      ]));
    });

    host.replaceChildren(
      el('div', { className: 'field-grid' }, [
        makeNumberField('진행 장(Chapter)', save.chapter, function (v) { Core.editWorld(state.bundle, 'chapter', v); }, -1, 4, 1),
        makeSelectField('게임 모드', [{ value: '0', label: '스토리 모드' }, { value: '1', label: '자유 모드' }], save.gameMode, function (v) { Core.editWorld(state.bundle, 'gameMode', Number(v)); }),
        makeSelectField('난이도', [{ value: '0', label: '쉬움' }, { value: '1', label: '보통' }, { value: '2', label: '어려움' }, { value: '3', label: '구사일생' }], save.gameDifficulty, function (v) { Core.editWorld(state.bundle, 'gameDifficulty', Number(v)); }),
        makeNumberField('특수 강화석', save.speEnhanceStone || 0, function (v) { Core.editWorld(state.bundle, 'speEnhanceStone', v); }, 0, null, 1),
        makeNumberField('연도', wt.year, function (v) { Core.editWorld(state.bundle, 'worldTime', { year: v }); }, 0, null, 1),
        makeNumberField('월', wt.month, function (v) { Core.editWorld(state.bundle, 'worldTime', { month: v }); }, 1, 12, 1),
        makeNumberField('일', wt.day, function (v) { Core.editWorld(state.bundle, 'worldTime', { day: v }); }, 1, 30, 1),
        makeNumberField('누적 악명', save.totalBadFame || 0, function (v) { Core.editWorld(state.bundle, 'totalBadFame', v); }, 0)
      ]),
      el('div', { className: 'sub-section' }, [
        el('h4', { text: '문파 세력 (' + (save.Forces ? save.Forces.length : 0) + '곳)' }),
        el('div', { className: 'table-wrap' }, el('table', {}, [
          el('thead', {}, el('tr', {}, [el('th', { text: '문파' }), el('th', { text: '등급' }), el('th', { text: '보유 은전' })])),
          forcesBody
        ]))
      ])
    );
  }

  function renderHeroTabs() {
    renderHeroesList();
    renderHeroDetail();
    renderStatsTab();
    renderSkillsTab();
    renderTagsTab();
    renderInventoryTab();
  }

  function renderAll() {
    renderSummary();
    renderHeroTabs();
    renderWorldTab();
    renderBackups();
  }

  function renderBackups() {
    var host = $('#backup-list');
    if (!host) return;
    if (!state.backups.length) {
      host.replaceChildren(el('div', { className: 'empty-state', text: '백업 내역이 없습니다.' }));
      return;
    }
    var list = el('div', { className: 'button-row' });
    state.backups.forEach(function (bk) {
      var name = typeof bk === 'string' ? bk : bk.name;
      list.appendChild(el('button', {
        type: 'button', text: '복구: ' + name,
        onClick: function () { restoreBackupByName(name); }
      }));
    });
    host.replaceChildren(list);
  }

  function openDiff() {
    var modal = $('#diff-modal');
    var body = $('#diff-modal-body');
    if (!modal || !body) return;
    if (!state.bundle) {
      toast('먼저 슬롯을 불러오세요.', true);
      return;
    }
    var out = serializeFiles();
    body.replaceChildren();
    FILES.forEach(function (name) {
      var dirty = !!(state.bundle.dirty && state.bundle.dirty[name]);
      var meta = (state.bundle.meta.files && state.bundle.meta.files[name]) || {};
      var preview = out[name] ? out[name].text.slice(0, 1000) : '';
      body.appendChild(el('section', { style: 'margin-bottom:14px' }, [
        el('h3', { text: name + (dirty ? ' [수정됨]' : ' [원본 유지]') + ' · ' + (meta.isGzip ? 'GZip' : '평문') + ' (' + (out[name] ? out[name].text.length : 0) + '자)' }),
        el('pre', { text: preview + (out[name] && out[name].text.length > 1000 ? '\n...(이하 생략)...' : '') })
      ]));
    });
    if (typeof modal.showModal === 'function' && !modal.open) modal.showModal();
    else modal.hidden = false;
  }

  function closeDiff() {
    var modal = $('#diff-modal');
    if (!modal) return;
    if (typeof modal.close === 'function' && modal.open) modal.close();
    modal.hidden = true;
  }

  async function downloadAll() {
    if (!state.bundle) return toast('먼저 슬롯을 불러오세요.', true);
    var serialized = serializeFiles();
    for (var i = 0; i < FILES.length; i++) {
      var name = FILES[i];
      var item = serialized[name];
      var bytes = await Codec.encodeSlotFile(item.text, { isGzip: item.isGzip, hasBom: item.hasBom });
      var blob = new Blob([bytes], { type: 'application/octet-stream' });
      var url = URL.createObjectURL(blob);
      var a = el('a', { href: url, download: name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout((function (u) { return function () { URL.revokeObjectURL(u); }; }(url)), 500);
    }
    toast('슬롯 파일 4개를 내려받았습니다.');
  }

  async function loadPickedFiles(fileList) {
    var incoming = {};
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      var buf = await f.arrayBuffer();
      var decoded = await Codec.decodeSlotFile(f.name, new Uint8Array(buf));
      var kind = Codec.detectFileKind(f.name, decoded.data);
      if (kind) incoming[kind] = decoded;
    }
    loadRawFiles(incoming, '로컬 선택 슬롯');
  }

  function nativeBridge() { return window.__LYZ_EDITOR__ || null; }
  function apiToken() {
    var m = $('meta[name="lyz-api-token"]');
    return window.__LYZ_API_TOKEN__ || (m && m.content) || '';
  }

  async function api(path, method, body) {
    var token = apiToken();
    if (!token) throw new Error('로컬 서버 토큰이 없습니다.');
    var opts = { method: method || 'GET', headers: { 'X-Lyz-Token': token } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    var res = await fetch(path, opts);
    var json = await res.json();
    if (!res.ok) throw new Error(json.error || ('요청 실패 (' + res.status + ')'));
    return json;
  }

  async function refreshNative() {
    var b = nativeBridge();
    if (!b || typeof b.getStatus !== 'function') return;
    try {
      var st = await b.getStatus();
      state.nativeReady = true;
      setBadge('#conn-badge', '네이티브 연결됨', true);
      if (st && Array.isArray(st.slots)) {
        state.serverSlots = st.slots;
        fillSlotSelect(st.slots);
      }
      if (typeof b.listBackups === 'function') {
        state.backups = await b.listBackups(state.slot) || [];
        renderBackups();
      }
    } catch (_) {
      state.nativeReady = false;
    }
  }

  function fillSlotSelect(slots) {
    var sel = $('#srv-slot-select');
    if (!sel) return;
    sel.replaceChildren();
    if (!slots.length) {
      sel.appendChild(el('option', { value: '', text: '슬롯 없음' }));
      return;
    }
    slots.forEach(function (s) {
      var name = typeof s === 'string' ? s : s.name;
      sel.appendChild(el('option', { value: name, text: name }));
    });
  }

  async function refreshServer() {
    if (!apiToken()) return;
    try {
      var res = await api('/api/slots');
      state.serverReady = true;
      setBadge('#conn-badge', '로컬 서버 연결됨', true);
      state.serverSlots = res.slots || [];
      fillSlotSelect(state.serverSlots);
      var bk = await api('/api/backups');
      state.backups = bk.backups || [];
      renderBackups();
    } catch (_) {}
  }

  async function loadSlotBySelection() {
    var sel = $('#srv-slot-select');
    var name = sel && sel.value;
    if (!name) return toast('슬롯을 선택하세요.', true);
    try {
      var b = nativeBridge();
      if (b && typeof b.loadSlot === 'function') {
        var nres = await b.loadSlot(name);
        loadRawFiles(nres.files || nres, name);
        return;
      }
      var sres = await api('/api/slot?name=' + encodeURIComponent(name));
      loadRawFiles(sres.files || sres, name);
    } catch (err) { toast(err.message, true); }
  }

  async function saveToCurrentTarget() {
    if (!state.bundle) return toast('저장할 슬롯이 없습니다.', true);
    var files = serializeFiles();
    try {
      var b = nativeBridge();
      if (b && typeof b.saveBundle === 'function') {
        var res = await b.saveBundle(state.slot, files);
        if (res && res.backups) { state.backups = res.backups; renderBackups(); }
        FILES.forEach(function (f) { state.bundle.dirty[f] = false; });
        renderSummary();
        toast('네이티브 안전 저장 완료');
        return;
      }
      var sres = await api('/api/save', 'POST', { name: state.slot, files: files });
      FILES.forEach(function (f) { state.bundle.dirty[f] = false; });
      if (sres && sres.backups) { state.backups = sres.backups; renderBackups(); }
      renderSummary();
      toast('로컬 서버 안전 저장 완료');
    } catch (err) { toast(err.message, true); }
  }

  async function restoreBackupByName(backupName) {
    try {
      var b = nativeBridge();
      if (b && typeof b.restoreBackup === 'function') {
        var r = await b.restoreBackup(state.slot, backupName);
        if (r && r.files) loadRawFiles(r.files, state.slot);
        toast('백업을 복구했습니다.');
        return;
      }
      var sr = await api('/api/restore', 'POST', { backup: backupName });
      if (sr && sr.files) loadRawFiles(sr.files, sr.slot || state.slot);
      toast('백업을 복구했습니다.');
    } catch (err) { toast(err.message, true); }
  }

  function bindUI() {
    $$('[role="tab"][data-tab]').forEach(function (tab) {
      tab.addEventListener('click', function () { selectTab(tab.getAttribute('data-tab')); });
      tab.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        var tabs = $$('[role="tab"][data-tab]');
        var idx = tabs.indexOf(tab);
        var next = tabs[(idx + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        next.focus();
        selectTab(next.getAttribute('data-tab'));
      });
    });

    var bind = function (sel, ev, fn) { var n = $(sel); if (n) n.addEventListener(ev, fn); };
    bind('#btn-load-demo', 'click', loadDemoSlot);
    bind('#btn-pick-file', 'click', function () { if ($('#file-input')) $('#file-input').click(); });
    bind('#file-input', 'change', function (e) {
      var list = Array.prototype.slice.call(e.target.files || []);
      e.target.value = '';
      if (list.length) loadPickedFiles(list).catch(function (err) { toast(err.message, true); });
    });

    var drop = $('#drop-zone');
    if (drop) {
      drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('drag-over'); });
      drop.addEventListener('dragleave', function () { drop.classList.remove('drag-over'); });
      drop.addEventListener('drop', function (e) {
        e.preventDefault();
        drop.classList.remove('drag-over');
        var list = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
        if (list.length) loadPickedFiles(list).catch(function (err) { toast(err.message, true); });
      });
    }

    bind('#btn-native-open', 'click', async function () {
      var b = nativeBridge();
      if (!b || typeof b.pickAndLoad !== 'function') return toast('네이티브 실행 환경에서만 사용할 수 있습니다.', true);
      try {
        var r = await b.pickAndLoad();
        if (r && r.files) loadRawFiles(r.files, r.name || '선택한 슬롯');
      } catch (err) { toast(err.message, true); }
    });
    bind('#btn-native-save', 'click', saveToCurrentTarget);
    bind('#btn-srv-refresh', 'click', function () { refreshNative(); refreshServer(); });
    bind('#btn-srv-load', 'click', loadSlotBySelection);
    bind('#btn-srv-save', 'click', saveToCurrentTarget);
    bind('#btn-validate', 'click', function () {
      if (!state.bundle) return toast('먼저 슬롯을 불러오세요.', true);
      afterMutation();
      toast(state.validation.ok ? '검증을 통과했습니다.' : state.validation.errors.join(' '), !state.validation.ok);
    });
    bind('#btn-preview-diff', 'click', openDiff);
    bind('#btn-download-all', 'click', function () { downloadAll().catch(function (err) { toast(err.message, true); }); });
    bind('#btn-close-diff', 'click', closeDiff);
    $$('[data-close-diff]').forEach(function (n) { n.addEventListener('click', closeDiff); });

    bind('#hero-search', 'input', function () { state.page = 0; renderHeroesList(); });
    bind('#hero-file-filter', 'change', function () { state.page = 0; renderHeroesList(); });
    bind('#hero-team-only', 'change', function () { state.page = 0; renderHeroesList(); });
    bind('#btn-select-player', 'click', function () {
      if (!state.bundle) return;
      var p = Core.findPlayer(state.bundle, false);
      if (p) selectHero(p.file, p.index);
    });
    bind('#theme-select', 'change', function (e) {
      try { localStorage.setItem('lyz_theme', e.target.value); } catch (_) {}
      document.documentElement.setAttribute('data-theme', e.target.value);
    });
  }

  function init() {
    var theme = 'auto';
    try { theme = localStorage.getItem('lyz_theme') || 'auto'; } catch (_) {}
    var sel = $('#theme-select');
    if (sel) {
      sel.value = theme;
      document.documentElement.setAttribute('data-theme', theme);
    }
    bindUI();
    renderAll();
    refreshNative();
    refreshServer();
    window.addEventListener('lyz-native-ready', refreshNative);
  }

  window.__LYZ_UI__ = {
    getState: getState,
    loadRawFiles: loadRawFiles,
    loadDemoSlot: loadDemoSlot,
    serializeFiles: serializeFiles,
    selectTab: selectTab,
    selectHero: selectHero
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}());
