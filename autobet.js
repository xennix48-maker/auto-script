/* ============================================================
 * 6Lottery Autobet — Professional Panel v3
 * Single-file floating UI + strategy engine
 * Usage:
 *   Console:  fetch('URL').then(r=>r.text()).then(eval)
 *   Bookmark: javascript:(()=>fetch('URL').then(r=>r.text()).then(eval))()
 *   Tamper:   @match site ... (auto-run)
 * ============================================================ */
(function AUTOBET_PRO() {
    'use strict';

    if (window.__AUTOBET_PRO__) {
        window.__AUTOBET_PRO__.ui.open();
        return;
    }

    /* ══════════════════════════════════════════════════════════
     * 1. CONFIG
     * ══════════════════════════════════════════════════════════ */
    const SITES = {
        '6Lottery': {
            base: 'https://6lotteryapi.com/api/webapi/',
            origins: ['https://6win598.com'],
            drawHost: 'https://draw.ar-lottery01.com/TrxWinGo/TrxWinGo_1M/GetHistoryIssuePage.json'
        },
        '777BIGWIN': {
            base: 'https://api.bigwinqaz.com/api/webapi/',
            origins: ['https://bigwinqaz.com'],
            drawHost: 'https://draw.ar-lottery01.com/TrxWinGo/TrxWinGo_1M/GetHistoryIssuePage.json'
        }
    };

    const DEFAULT_CFG = {
        site: '6Lottery',
        gameType: 'TRX',
        betType: 'BS',
        strategy: 'BS_ORDER',
        bsPattern: 'BSBSBSBSBS',
        bettingStrategy: 'Martingale',
        betSizes: [100, 300, 500, 900],
        targetProfit: 10000,
        stopLoss: 5000,
        virtualMode: true,
        virtualBalance: 10000,
        entryLayer: 1,
        slLayer: 0,
        loopDelayMs: 1200,
        resultPollMs: 2500,
        resultTimeoutMs: 90000,
        maxConsecutiveErrors: 10,
        balanceWarnRatio: 3,
        customBetPattern: 'B,S,B,B,S',
        leoBigPattern: 'BBSBBSBBSB',
        leoSmallPattern: 'SSBSSBSSBS',
        trendWaitCount: 0,
        alternateWaitCount: 0
    };

    const LS_KEY = 'autobet_pro_cfg_v3';

    let cfg = Object.assign({}, DEFAULT_CFG, safeJSON(localStorage.getItem(LS_KEY)) || {});
    function safeJSON(s) { try { return JSON.parse(s); } catch (e) { return null; } }

    /* ══════════════════════════════════════════════════════════
     * 2. STATE
     * ══════════════════════════════════════════════════════════ */
    const S = {
        running: false,
        stopRequested: false,
        token: null,
        baseUrl: '',
        origin: '',
        drawHost: '',
        balance: null,
        startBalance: null,
        profit: 0,
        wins: 0,
        losses: 0,
        lastIssue: null,
        consecutiveErrors: 0,
        history: [],
        logs: [],

        patternIdx: 0,
        customPatternIdx: 0,
        martinIndex: 0,
        dalembertUnits: 1,
        customIdx: 0,
        consecutiveLosses: 0,
        skipMode: false,
        entryLayerState: { waiting: false, lossStreak: 0 },
        slSkipWaitingWin: false,
        sniper: { active: false, dir: null, idx: 0, seq: [], hits: 0 },
        dream: { first: true, pattern: null, idx: 0 },
        leo: { idx: 0 },
        babio: { pos: 8 },
        beatrix: { waiting: true, period: null },
        colorTrend: { last: null },
        trendState: { last: null, skip: false },
        altState: { last: null, skip: false },

        lastResults: [],
        lastNumbers: [],
        lastColors: [],
        rawHistory: []
    };

    /* ══════════════════════════════════════════════════════════
     * 3. UTILITIES
     * ══════════════════════════════════════════════════════════ */
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const ts = () => new Date().toTimeString().slice(0, 8);
    const rndHex = (n = 32) => {
        const a = new Uint8Array(n / 2);
        crypto.getRandomValues(a);
        return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
    };

    function log(msg, cls = 'info') {
        const line = { t: ts(), m: msg, c: cls };
        S.logs.push(line);
        if (S.logs.length > 500) S.logs.shift();
        UI.pushLog(line);
        console.log(`[AUTOBET ${line.t}] ${msg}`);
    }

    function numberToBS(n) { return parseInt(n, 10) >= 5 ? 'B' : 'S'; }
    function numberToColor(n) {
        const x = parseInt(n, 10) % 10;
        if ([1, 3, 7, 9].includes(x)) return 'G';
        if ([0, 5].includes(x)) return 'V';
        return 'R';
    }
    function colorName(c) { return c === 'G' ? '🟢 GREEN' : c === 'V' ? '🟣 VIOLET' : c === 'R' ? '🔴 RED' : c; }

    /* ══════════════════════════════════════════════════════════
     * 4. TOKEN + SIGNATURE
     * ══════════════════════════════════════════════════════════ */
    async function ensureMd5() {
        if (window.md5) return;
        await new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/blueimp-md5@2.19.0/js/md5.min.js';
            s.onload = res;
            s.onerror = () => rej(new Error('MD5 load failed'));
            document.head.appendChild(s);
        });
    }

    function findToken() {
        const pat = /token|auth|jwt|access|bearer/i;
        const valPat = /^[A-Za-z0-9._\-]{20,}$/;
        for (const store of [localStorage, sessionStorage]) {
            for (let i = 0; i < store.length; i++) {
                const k = store.key(i);
                if (pat.test(k)) {
                    let v = store.getItem(k);
                    try { v = JSON.parse(v); } catch (e) {}
                    if (typeof v === 'object' && v) {
                        v = v.token || v.access_token || v.accessToken || v.jwt || null;
                    }
                    if (typeof v === 'string') {
                        v = v.replace(/^"|"$/g, '');
                        if (valPat.test(v)) return v;
                    }
                }
            }
        }
        for (const g of ['token', 'authToken', 'accessToken', '__token__']) {
            try {
                const v = window[g];
                if (typeof v === 'string' && valPat.test(v)) return v;
            } catch (e) {}
        }
        return null;
    }

    function buildSignature(data) {
        const f = {};
        const exclude = ['signature', 'track', 'xosoBettingData'];
        Object.keys(data).sort().forEach(k => {
            const v = data[k];
            if (v !== null && v !== '' && !exclude.includes(k)) f[k] = v === 0 ? 0 : v;
        });
        return md5(JSON.stringify(f)).toUpperCase();
    }

    /* ══════════════════════════════════════════════════════════
     * 5. API
     * ══════════════════════════════════════════════════════════ */
    function resolveSite() {
        const s = SITES[cfg.site] || SITES['6Lottery'];
        S.baseUrl = s.base;
        S.origin = location.origin || s.origins[0];
        S.drawHost = s.drawHost;
    }

    async function api(endpoint, body = {}) {
        if (!S.token) S.token = findToken();
        if (!S.token) throw new Error('Token not found — login required');

        const payload = Object.assign({}, body);
        payload.random = payload.random || rndHex(32);
        payload.signature = buildSignature(payload);
        payload.timestamp = Math.floor(Date.now() / 1000);

        const res = await fetch(S.baseUrl + endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json;charset=UTF-8',
                'Authorization': S.token,
                'Ar-Origin': S.origin,
                'Origin': S.origin,
                'Referer': S.origin + '/'
            },
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

    function typeIdFor(g) { return ({ TRX: 13, WINGO: 1, WINGO_30S: 30, WINGO_3MIN: 2, WINGO_5MIN: 3 })[g] || 1; }
    function issueEndpoint(g) { return g === 'TRX' ? 'GetTrxGameIssue' : 'GetGameIssue'; }
    function betEndpoint(g) { return g === 'TRX' ? 'GameTrxBetting' : 'GameBetting'; }

    async function fetchBalance() {
        const r = await api('GetBalance', { language: 7 });
        const d = r.data || {};
        const v = d.Amount ?? d.amount ?? d.balance;
        return v !== undefined && v !== null ? parseFloat(v) : null;
    }

    async function fetchIssue() {
        const r = await api(issueEndpoint(cfg.gameType), { typeId: typeIdFor(cfg.gameType), language: 7 });
        if (cfg.gameType === 'TRX') return r.data?.predraw?.issueNumber || null;
        return r.data?.issueNumber || null;
    }

    async function fetchResults() {
        if (cfg.gameType === 'TRX') {
            try {
                const r = await fetch(S.drawHost + '?ts=' + Date.now(), { cache: 'no-cache' });
                const d = await r.json();
                return d.list || d.data?.list || [];
            } catch (e) { return []; }
        }
        try {
            const r = await api('GetNoaverageEmerdList', {
                pageSize: 10, pageNo: 1,
                typeId: typeIdFor(cfg.gameType), language: 7
            });
            return r.data?.list || [];
        } catch (e) { return []; }
    }

    async function placeBet(issue, selectType, amount, count) {
        return api(betEndpoint(cfg.gameType), {
            typeId: typeIdFor(cfg.gameType),
            issuenumber: issue,
            language: 7,
            gameType: cfg.betType === 'COLOR' ? 0 : 2,
            amount, betCount: count,
            selectType: parseInt(selectType, 10)
        });
    }

    /* ══════════════════════════════════════════════════════════
     * 6. STRATEGY
     * ══════════════════════════════════════════════════════════ */
    function selectMap() {
        return cfg.betType === 'COLOR'
            ? { G: 11, V: 12, R: 10 }
            : { B: 13, S: 14 };
    }

    function pushResult(num, bs, color, issue) {
        S.lastResults.push(bs); if (S.lastResults.length > 30) S.lastResults.shift();
        S.lastNumbers.push(String(num)); if (S.lastNumbers.length > 30) S.lastNumbers.shift();
        S.lastColors.push(color); if (S.lastColors.length > 30) S.lastColors.shift();
        S.rawHistory.unshift({ issue, num, bs, color, t: Date.now() });
        if (S.rawHistory.length > 50) S.rawHistory.pop();
    }

    function seedResults(list) {
        const ordered = list.slice(0, 30).reverse();
        for (const item of ordered) {
            if (!item || item.number === undefined) continue;
            const num = parseInt(item.number, 10) % 10;
            pushResult(num, numberToBS(num), numberToColor(num), item.issueNumber);
        }
    }

    function nextChoice() {
        const strat = cfg.strategy;
        const last = S.lastResults;
        const lastNum = S.lastNumbers;

        switch (strat) {
            case 'BS_ORDER': {
                const p = (cfg.bsPattern || 'BS').replace(/[^BS]/g, '') || 'BS';
                return { ch: p[S.patternIdx % p.length], advance: true };
            }
            case 'CUSTOM_PATTERN': {
                const items = cfg.customBetPattern.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
                if (!items.length) return { ch: 'B', advance: true };
                return { ch: items[S.customPatternIdx % items.length], advance: true };
            }
            case 'TREND_FOLLOW': {
                if (cfg.betType === 'COLOR') {
                    if (!S.colorTrend.last) {
                        return { ch: ['G', 'V', 'R'][Math.floor(Math.random() * 3)], advance: true };
                    }
                    return { ch: S.colorTrend.last, advance: true };
                }
                if (cfg.trendWaitCount > 0) {
                    const need = cfg.trendWaitCount * 2;
                    if (last.length >= need) {
                        const tail = last.slice(-need).join('');
                        const bs = 'BS'.repeat(cfg.trendWaitCount);
                        const sb = 'SB'.repeat(cfg.trendWaitCount);
                        S.trendState.skip = (tail === bs || tail === sb);
                    }
                    if (S.trendState.skip) return { ch: null, skip: true, reason: 'BS/SB Wait' };
                }
                if (!S.trendState.last) return { ch: 'B', advance: true };
                return { ch: S.trendState.last, advance: true };
            }
            case 'ALTERNATE': {
                if (cfg.alternateWaitCount > 0) {
                    const need = cfg.alternateWaitCount * 2;
                    if (last.length >= need) {
                        const tail = last.slice(-need).join('');
                        const bb = 'BB'.repeat(cfg.alternateWaitCount);
                        const ss = 'SS'.repeat(cfg.alternateWaitCount);
                        S.altState.skip = (tail === bb || tail === ss);
                    }
                    if (S.altState.skip) {
                        const opp = S.altState.last === 'B' ? 'S' : 'B';
                        return { ch: opp, skip: true, reason: 'BB/SS Wait' };
                    }
                }
                if (!S.altState.last) return { ch: 'B', advance: true };
                return { ch: S.altState.last === 'B' ? 'S' : 'B', advance: true };
            }
            case 'AI_PREDICTION': {
                if (!last.length) return { ch: 'B', advance: true };
                const w = last.slice(-10);
                const counts = { B: 0, S: 0 };
                w.forEach(r => counts[r]++);
                const last3 = w.slice(-3).join('');
                if (last3 === 'BBB') return { ch: 'S', advance: true };
                if (last3 === 'SSS') return { ch: 'B', advance: true };
                if (counts.B === counts.S) return { ch: last[last.length - 1], advance: true };
                return { ch: counts.B > counts.S ? 'B' : 'S', advance: true };
            }
            case 'BABIO': {
                if (!last.length) return { ch: 'B', advance: true };
                const idx = last.length - S.babio.pos;
                if (idx >= 0) return { ch: last[idx], advance: true };
                return { ch: last[last.length - 1], advance: true };
            }
            case 'DREAM': {
                if (!S.dream.pattern) return { ch: 'B', advance: true };
                if (S.dream.idx >= S.dream.pattern.length) S.dream.idx = 0;
                return { ch: S.dream.pattern[S.dream.idx], advance: true };
            }
            case 'LEO': {
                if (!last.length) return { ch: 'B', advance: true };
                const lastRes = last[last.length - 1];
                const pattern = lastRes === 'B' ? cfg.leoBigPattern : cfg.leoSmallPattern;
                return { ch: pattern[S.leo.idx % pattern.length], advance: true };
            }
            case 'ALINKAR': {
                if (!last.length) return { ch: Math.random() < 0.5 ? 'B' : 'S', advance: true };
                const lastRes = last[last.length - 1];
                let streak = 1;
                for (let i = last.length - 2; i >= 0; i--) {
                    if (last[i] === lastRes) streak++; else break;
                }
                if (streak === 1) return { ch: lastRes === 'B' ? 'S' : 'B', advance: true };
                if (streak === 2) return { ch: lastRes, advance: true };
                if (streak === 3) return { ch: lastRes === 'B' ? 'S' : 'B', advance: true };
                return { ch: lastRes, advance: true };
            }
            case 'MAY_BARANI': {
                if (last.length < 5) return { ch: last[last.length - 1] || 'B', advance: true };
                const recent = last.slice(-5).map(r => r === 'B' ? 7 : 2);
                const sum = recent.reduce((a, b) => a + b, 0);
                const v = Math.abs(sum) % 10;
                return { ch: v >= 5 ? 'B' : 'S', advance: true };
            }
            case 'BEATRIX': {
                if (S.beatrix.waiting) return { ch: null, skip: true, reason: 'Waiting for 7' };
                const digit = parseInt(String(S.beatrix.period).slice(-1), 10);
                const ch = [0, 1, 2, 3, 7].includes(digit) ? 'S' : 'B';
                return { ch, advance: true };
            }
            case 'SNIPER': {
                const sn = S.sniper;
                if (!sn.active && lastNum.length) {
                    const ln = lastNum[lastNum.length - 1];
                    if (ln === '0') { sn.active = true; sn.dir = 'B'; sn.seq = ['B']; sn.idx = 0; }
                    else if (ln === '9') { sn.active = true; sn.dir = 'S'; sn.seq = ['S']; sn.idx = 0; }
                }
                if (!sn.active) return { ch: null, skip: true, reason: 'SNIPER waiting' };
                if (sn.idx >= sn.seq.length) sn.seq.push(sn.dir);
                return { ch: sn.seq[sn.idx], advance: true };
            }
            default:
                return { ch: 'B', advance: true };
        }
    }

    function postBetState(choice, isWin, num, issue) {
        const strat = cfg.strategy;

        if (strat === 'DREAM') {
            const map = {
                "0": "SBBSBSSBBS", "1": "BBSBSBSBBS", "2": "SBSBBSBSBB", "3": "BSBSBSSBSB",
                "4": "SBBSBSBBSS", "5": "BSSBSBBSBS", "6": "BSBSSBSBSB", "7": "SBSBSBSSBB",
                "8": "BSBBSBSBSB", "9": "SBSBBSSBSB"
            };
            if (isWin) {
                S.dream.pattern = map[num] || map["0"];
                S.dream.idx = 0;
            } else if (S.dream.pattern) {
                S.dream.idx++;
            }
        }
        if (strat === 'LEO') S.leo.idx++;
        if (strat === 'BABIO' && !isWin) S.babio.pos = S.babio.pos === 8 ? 5 : 8;
        if (strat === 'BEATRIX') {
            if (num === '7') { S.beatrix.waiting = false; S.beatrix.period = issue; }
            else S.beatrix.waiting = true;
        }
        if (strat === 'TREND_FOLLOW') {
            S.trendState.last = numberToBS(num);
            if (cfg.betType === 'COLOR') S.colorTrend.last = numberToColor(num);
            if (S.trendState.skip && isWin) S.trendState.skip = false;
        }
        if (strat === 'ALTERNATE') {
            S.altState.last = numberToBS(num);
            if (S.altState.skip && isWin) S.altState.skip = false;
        }
        if (strat === 'SNIPER' && S.sniper.active) {
            if (isWin) {
                S.sniper.hits++;
                S.sniper.active = false;
                S.sniper.seq = [];
                S.sniper.idx = 0;
                log(`🎯 SNIPER hit ${S.sniper.hits}/2`, 'ok');
                if (S.sniper.hits >= 2) {
                    log('🏁 SNIPER 2/2 — stopping', 'ok');
                    S.stopRequested = true;
                }
            } else {
                S.sniper.idx++;
                if (S.sniper.idx >= 4) {
                    log('❌ SNIPER max bets — stopping', 'err');
                    S.stopRequested = true;
                }
            }
        }
    }

    /* ══════════════════════════════════════════════════════════
     * 7. BET SIZE
     * ══════════════════════════════════════════════════════════ */
    function currentBetAmount() {
        const bs = cfg.betSizes;
        switch (cfg.bettingStrategy) {
            case "D'Alembert": return bs[0] * S.dalembertUnits;
            case 'Custom': return bs[Math.min(S.customIdx, bs.length - 1)];
            default: return bs[Math.min(S.martinIndex, bs.length - 1)];
        }
    }

    function updateBetting(isWin) {
        const len = cfg.betSizes.length;
        switch (cfg.bettingStrategy) {
            case 'Martingale':
                S.martinIndex = isWin ? 0 : Math.min(S.martinIndex + 1, len - 1);
                break;
            case 'Anti-Martingale':
                S.martinIndex = isWin ? Math.min(S.martinIndex + 1, len - 1) : 0;
                break;
            case "D'Alembert":
                S.dalembertUnits = isWin ? Math.max(1, S.dalembertUnits - 1) : S.dalembertUnits + 1;
                break;
            case 'Custom':
                S.customIdx = isWin ? Math.max(0, S.customIdx - 1) : Math.min(len - 1, S.customIdx + 1);
                break;
        }
    }

    /* ══════════════════════════════════════════════════════════
     * 8. LAYERS
     * ══════════════════════════════════════════════════════════ */
    function shouldSkipByEntryLayer() {
        if (cfg.entryLayer === 1) return false;
        return S.entryLayerState.waiting;
    }
    function updateEntryLayer(isWin) {
        if (cfg.entryLayer === 2) {
            S.entryLayerState.waiting = isWin ? true : false;
        } else if (cfg.entryLayer === 3) {
            if (isWin) { S.entryLayerState.waiting = true; S.entryLayerState.lossStreak = 0; }
            else {
                S.entryLayerState.lossStreak++;
                if (S.entryLayerState.lossStreak >= 2) S.entryLayerState.waiting = false;
            }
        }
    }
    function shouldSkipBySL() {
        if (!cfg.slLayer || cfg.slLayer <= 0) return false;
        return S.skipMode;
    }
    function updateSL(isWin) {
        if (!cfg.slLayer || cfg.slLayer <= 0) return;
        if (isWin) {
            S.consecutiveLosses = 0;
            if (S.slSkipWaitingWin) {
                S.skipMode = false;
                S.slSkipWaitingWin = false;
                log('SL Layer: skip-win achieved — resuming', 'ok');
            }
        } else {
            S.consecutiveLosses++;
            if (S.consecutiveLosses >= cfg.slLayer && !S.skipMode) {
                S.skipMode = true;
                S.slSkipWaitingWin = true;
                log(`SL Layer: ${cfg.slLayer} losses — skip until win`, 'warn');
            }
        }
    }

    /* ══════════════════════════════════════════════════════════
     * 9. MAIN LOOP
     * ══════════════════════════════════════════════════════════ */
    async function mainLoop() {
        log('=== AUTOBET STARTED ===', 'ok');
        resolveSite();
        S.token = findToken();
        if (!S.token) {
            log('❌ Token not found — login to site first', 'err');
            stop(); return;
        }
        log('🔑 Token OK', 'ok');

        if (cfg.virtualMode) {
            S.balance = cfg.virtualBalance;
        } else {
            try { S.balance = await fetchBalance(); } catch (e) { S.balance = null; }
        }
        if (S.balance === null || isNaN(S.balance)) {
            log('❌ Balance fetch failed', 'err');
            stop(); return;
        }
        S.startBalance = S.balance;
        S.profit = 0;
        log(`💳 Start balance: ${S.balance.toFixed(2)}`, 'info');

        const seed = await fetchResults();
        if (Array.isArray(seed) && seed.length) {
            seedResults(seed);
            log(`📊 Seeded ${seed.length} results`, 'info');
        }

        S.lastIssue = null;
        S.consecutiveErrors = 0;
        S.wins = 0; S.losses = 0;
        let lastWarnTime = 0;

        while (S.running && !S.stopRequested) {
            try {
                if (cfg.virtualMode) S.balance = cfg.virtualBalance;
                else {
                    const b = await fetchBalance();
                    if (b !== null) S.balance = b;
                }
                S.profit = S.balance - S.startBalance;
                UI.updateStats();

                if (cfg.targetProfit > 0 && S.profit >= cfg.targetProfit) {
                    log(`🏆 PROFIT TARGET HIT: +${S.profit.toFixed(2)}`, 'ok');
                    break;
                }
                if (cfg.stopLoss > 0 && S.profit <= -cfg.stopLoss) {
                    log(`🔻 STOP LOSS HIT: ${S.profit.toFixed(2)}`, 'err');
                    break;
                }
                const minBet = Math.min(...cfg.betSizes);
                if (S.balance < minBet) {
                    log(`❌ Insufficient balance: ${S.balance} < ${minBet}`, 'err');
                    break;
                }
                if (!cfg.virtualMode && S.balance < minBet * cfg.balanceWarnRatio) {
                    const now = Date.now();
                    if (now - lastWarnTime > 60000) {
                        log(`⚠️ Low balance: ${S.balance.toFixed(2)}`, 'warn');
                        lastWarnTime = now;
                    }
                }

                const issue = await fetchIssue();
                if (!issue || issue === S.lastIssue) { await sleep(1000); continue; }

                let choice, skip = false, skipReason = '';
                if (shouldSkipByEntryLayer()) { skip = true; skipReason = 'Entry Layer'; }
                else if (shouldSkipBySL()) { skip = true; skipReason = 'SL Layer'; }
                else {
                    const dec = nextChoice();
                    if (dec.skip) { skip = true; skipReason = dec.reason || 'Strategy Wait'; }
                    else choice = dec.ch;
                }
                if (skip && !choice) choice = S.lastResults[S.lastResults.length - 1] || 'B';
                if (!choice) { await sleep(1000); continue; }

                const map = selectMap();
                const selectType = map[choice];
                if (!selectType) { log(`❌ Invalid choice: ${choice}`, 'err'); await sleep(1500); continue; }

                const amount = currentBetAmount();
                const shortIssue = issue.slice(-5);
                const displayChoice = cfg.betType === 'COLOR' ? colorName(choice) : (choice === 'B' ? 'BIG' : 'SMALL');

                if (skip) {
                    log(`⏭️ SKIP ${shortIssue} — ${skipReason}`, 'warn');
                    S.lastIssue = issue;
                    await waitForResult(issue);
                    await sleep(cfg.loopDelayMs);
                    continue;
                }

                log(`🎯 BET ${shortIssue} — ${displayChoice} ${amount}Ks`, 'info');

                let resp;
                if (cfg.virtualMode) resp = { code: 0, _virtual: true };
                else resp = await placeBet(issue, selectType, amount, 1);

                if (!resp._virtual && resp.code !== 0) {
                    log(`❌ Bet failed: ${resp.msg || resp.error || 'unknown'}`, 'err');
                    S.consecutiveErrors++;
                    if (S.consecutiveErrors >= cfg.maxConsecutiveErrors) {
                        log('Too many errors — stop', 'err');
                        break;
                    }
                    await sleep(2000);
                    continue;
                }
                S.consecutiveErrors = 0;
                S.lastIssue = issue;

                const settled = await waitForResult(issue);
                if (!settled) { log(`⏱️ Result timeout ${shortIssue}`, 'warn'); continue; }

                const num = String(parseInt(settled.number, 10) % 10);
                const bs = numberToBS(num);
                const color = numberToColor(num);
                const isWin = cfg.betType === 'COLOR' ? choice === color : choice === bs;

                pushResult(num, bs, color, issue);
                postBetState(choice, isWin, num, issue);
                updateEntryLayer(isWin);
                updateSL(isWin);
                updateBetting(isWin);

                if (cfg.virtualMode) {
                    cfg.virtualBalance += isWin ? amount * 0.96 : -amount;
                    S.balance = cfg.virtualBalance;
                }
                S.profit = S.balance - S.startBalance;

                if (isWin) {
                    S.wins++;
                    log(`✅ WIN  ${shortIssue} → ${num} ${bs} ${color}  +${(amount * 0.96).toFixed(2)}  bal=${S.balance.toFixed(2)}  P/L=${S.profit >= 0 ? '+' : ''}${S.profit.toFixed(2)}`, 'ok');
                } else {
                    S.losses++;
                    log(`❌ LOSE ${shortIssue} → ${num} ${bs} ${color}  -${amount}  bal=${S.balance.toFixed(2)}  P/L=${S.profit >= 0 ? '+' : ''}${S.profit.toFixed(2)}`, 'err');
                }

                S.history.unshift({ issue, choice, num, bs, color, isWin, amount, t: Date.now() });
                if (S.history.length > 30) S.history.pop();
                UI.updateStats();

                await sleep(cfg.loopDelayMs);
            } catch (e) {
                log('Loop error: ' + e.message, 'err');
                S.consecutiveErrors++;
                if (S.consecutiveErrors >= cfg.maxConsecutiveErrors) {
                    log('Too many errors — stopping', 'err');
                    break;
                }
                await sleep(3000);
            }
        }
        log(`=== STOPPED  W:${S.wins} L:${S.losses}  P/L:${S.profit >= 0 ? '+' : ''}${S.profit.toFixed(2)} ===`, 'ok');
        stop();
    }

    async function waitForResult(issue) {
        const deadline = Date.now() + cfg.resultTimeoutMs;
        while (Date.now() < deadline) {
            await sleep(cfg.resultPollMs);
            const list = await fetchResults();
            const found = list.find(x => x.issueNumber === issue);
            if (found) return found;
        }
        return null;
    }

    function stop() {
        S.running = false;
        S.stopRequested = true;
        UI.setRunning(false);
        UI.updateStats();
    }

    /* ══════════════════════════════════════════════════════════
     * 10. UI — Bottom sheet + tabs
     * ══════════════════════════════════════════════════════════ */
    const UI = {
        el: {},
        build() {
            const root = document.createElement('div');
            root.id = 'autobet-pro-root';
            document.body.appendChild(root);
            this.root = root;

            // inject styles
            const style = document.createElement('style');
            style.id = 'autobet-pro-style';
            style.textContent = CSS;
            document.head.appendChild(style);

            // FAB
            const fab = document.createElement('div');
            fab.className = 'ab-fab';
            fab.innerHTML = '<span class="ab-fab-ico">🤖</span><span class="ab-fab-txt">AUTOBET</span>';
            root.appendChild(fab);
            this.el.fab = fab;

            // Panel
            const panel = document.createElement('div');
            panel.className = 'ab-panel';
            panel.innerHTML = TEMPLATE;
            root.appendChild(panel);
            this.el.panel = panel;

            // Cache refs
            const $ = sel => panel.querySelector(sel);
            this.el.status = $('[data-el="status"]');
            this.el.tokenWarn = $('[data-el="tokenWarn"]');
            this.el.tabs = panel.querySelectorAll('.ab-tab');
            this.el.tabPanes = panel.querySelectorAll('.ab-tabpane');
            this.el.log = $('[data-el="log"]');
            this.el.runBtn = $('[data-el="runBtn"]');
            this.el.stopBtn = $('[data-el="stopBtn"]');
            this.el.saveBtn = $('[data-el="saveBtn"]');
            this.el.stat = {
                balance: $('[data-el="st-balance"]'),
                profit: $('[data-el="st-profit"]'),
                wins: $('[data-el="st-wins"]'),
                losses: $('[data-el="st-losses"]'),
                ratio: $('[data-el="st-ratio"]'),
                streak: $('[data-el="st-streak"]'),
                last: $('[data-el="st-last"]')
            };

            // Events
            fab.addEventListener('click', () => this.toggle());
            $('[data-el="close"]').addEventListener('click', () => this.close());
            this.el.tabs.forEach(tab => tab.addEventListener('click', () => this.switchTab(tab.dataset.tab)));
            this.el.saveBtn.addEventListener('click', () => { this.readConfig(); log('💾 Saved', 'ok'); });
            this.el.runBtn.addEventListener('click', () => this.startRun());
            this.el.stopBtn.addEventListener('click', () => { log('⏹ Stop requested', 'warn'); S.stopRequested = true; S.running = false; });
            $('[data-el="resetBtn"]').addEventListener('click', () => {
                S.wins = 0; S.losses = 0; S.profit = 0; S.history = [];
                this.updateStats();
                log('🔄 Stats reset', 'warn');
            });
            $('[data-el="clearLogBtn"]').addEventListener('click', () => { this.el.log.innerHTML = ''; S.logs = []; });
            $('[data-el="copyLogBtn"]').addEventListener('click', () => {
                const text = S.logs.map(l => `[${l.t}] ${l.m}`).join('\n');
                navigator.clipboard.writeText(text).then(() => log('📋 Log copied', 'ok')).catch(() => {});
            });

            // token watcher
            setInterval(() => {
                if (S.running) return;
                const t = findToken();
                this.el.tokenWarn.classList.toggle('show', !t);
            }, 5000);

            this.writeConfig();
            this.updateStats();
            this.switchTab('game');
            this.el.tokenWarn.classList.toggle('show', !findToken());
            log('Panel ready — login to site, then ▶ Run', 'info');
        },

        open() { this.el.panel.classList.add('open'); },
        close() { this.el.panel.classList.remove('open'); },
        toggle() { this.el.panel.classList.toggle('open'); },

        switchTab(name) {
            this.el.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
            this.el.tabPanes.forEach(p => p.classList.toggle('active', p.dataset.pane === name));
        },

        pushLog(line) {
            if (!this.el.log) return;
            const d = document.createElement('div');
            d.className = 'ab-line ' + line.c;
            d.textContent = `[${line.t}] ${line.m}`;
            this.el.log.appendChild(d);
            this.el.log.scrollTop = this.el.log.scrollHeight;
            while (this.el.log.children.length > 300) this.el.log.removeChild(this.el.log.firstChild);
        },

        setRunning(on) {
            this.el.status.textContent = on ? 'RUNNING' : 'STOPPED';
            this.el.status.className = 'ab-status ' + (on ? 'running' : 'stopped');
            this.el.runBtn.disabled = on;
            this.el.stopBtn.disabled = !on;
        },

        updateStats() {
            const e = this.el.stat;
            e.balance.textContent = S.balance !== null ? S.balance.toFixed(2) : '—';
            e.profit.textContent = (S.profit >= 0 ? '+' : '') + (S.profit || 0).toFixed(2);
            e.profit.className = S.profit > 0 ? 'ok' : S.profit < 0 ? 'err' : '';
            e.wins.textContent = S.wins;
            e.losses.textContent = S.losses;
            const total = S.wins + S.losses;
            e.ratio.textContent = total ? `${S.wins}/${total}` : '—';
            let streak = 0, lastWin = null;
            for (const h of S.history) {
                if (lastWin === null) { lastWin = h.isWin; streak = 1; }
                else if (h.isWin === lastWin) streak++;
                else break;
            }
            e.streak.textContent = lastWin === null ? '—' : (lastWin ? `+${streak}W` : `-${streak}L`);
            e.streak.className = lastWin === false ? 'err' : lastWin === true ? 'ok' : '';
            const last = S.history[0];
            e.last.textContent = last ? `${last.num} ${last.bs}` : '—';
        },

        writeConfig() {
            this.el.panel.querySelectorAll('[data-cfg]').forEach(el => {
                const k = el.dataset.cfg;
                const v = cfg[k];
                if (el.type === 'checkbox') el.checked = !!v;
                else if (k === 'betSizes') el.value = (v || []).join(',');
                else el.value = v ?? '';
            });
        },

        readConfig() {
            this.el.panel.querySelectorAll('[data-cfg]').forEach(el => {
                const k = el.dataset.cfg;
                let v;
                if (el.type === 'checkbox') v = el.checked;
                else if (el.type === 'number') v = parseFloat(el.value) || 0;
                else v = el.value;
                if (k === 'betSizes') {
                    v = String(v).split(',').map(x => parseInt(x.trim(), 10)).filter(n => !isNaN(n) && n > 0);
                    if (!v.length) v = [100];
                }
                if (['entryLayer', 'slLayer', 'trendWaitCount', 'alternateWaitCount'].includes(k)) v = parseInt(v, 10) || 0;
                cfg[k] = v;
            });
            localStorage.setItem(LS_KEY, JSON.stringify(cfg));
        },

        startRun() {
            if (S.running) return;
            this.readConfig();
            S.running = true;
            S.stopRequested = false;
            S.wins = 0; S.losses = 0; S.profit = 0; S.history = [];
            S.martinIndex = 0; S.dalembertUnits = 1; S.customIdx = 0;
            S.patternIdx = 0; S.customPatternIdx = 0;
            S.consecutiveLosses = 0; S.skipMode = false; S.slSkipWaitingWin = false;
            S.entryLayerState = { waiting: cfg.entryLayer > 1, lossStreak: 0 };
            S.sniper = { active: false, dir: null, idx: 0, seq: [], hits: 0 };
            S.dream = { first: true, pattern: null, idx: 0 };
            S.leo = { idx: 0 };
            S.babio = { pos: 8 };
            S.beatrix = { waiting: true, period: null };
            S.colorTrend = { last: null };
            S.trendState = { last: null, skip: false };
            S.altState = { last: null, skip: false };
            S.lastResults = []; S.lastNumbers = []; S.lastColors = []; S.rawHistory = [];
            S.lastIssue = null;
            S.consecutiveErrors = 0;

            this.setRunning(true);
            this.updateStats();
            ensureMd5().then(() => mainLoop()).catch(e => {
                log('❌ MD5 load failed: ' + e.message, 'err');
                stop();
            });
        }
    };

    /* ── Template ─────────────────────────────────────────────── */
    const TEMPLATE = `
        <div class="ab-header">
            <div class="ab-title">
                <span class="ab-dot"></span>
                <span>AUTOBET PRO</span>
                <span class="ab-status stopped" data-el="status">STOPPED</span>
            </div>
            <div class="ab-close" data-el="close">✕</div>
        </div>

        <div class="ab-token-warn" data-el="tokenWarn">
            ⚠️ No token — please log in to the site first
        </div>

        <div class="ab-tabs">
            <div class="ab-tab active" data-tab="game">🎮 Game</div>
            <div class="ab-tab" data-tab="strategy">🧠 Strategy</div>
            <div class="ab-tab" data-tab="bet">💰 Bet</div>
            <div class="ab-tab" data-tab="risk">🛡 Risk</div>
            <div class="ab-tab" data-tab="log">📋 Log</div>
        </div>

        <div class="ab-body">

            <!-- GAME TAB -->
            <div class="ab-tabpane active" data-pane="game">
                <div class="ab-field">
                    <label>Site</label>
                    <select data-cfg="site">
                        <option value="6Lottery">6Lottery</option>
                        <option value="777BIGWIN">777BIGWIN</option>
                    </select>
                </div>
                <div class="ab-field">
                    <label>Game Type</label>
                    <select data-cfg="gameType">
                        <option value="TRX">TRX 1min</option>
                        <option value="WINGO">WINGO 1min</option>
                        <option value="WINGO_30S">WINGO 30s</option>
                        <option value="WINGO_3MIN">WINGO 3min</option>
                        <option value="WINGO_5MIN">WINGO 5min</option>
                    </select>
                </div>
                <div class="ab-field">
                    <label>Bet Type</label>
                    <select data-cfg="betType">
                        <option value="BS">Big / Small</option>
                        <option value="COLOR">Color (R/G/V)</option>
                    </select>
                </div>
                <div class="ab-field ab-switch">
                    <label>Virtual Mode</label>
                    <input type="checkbox" data-cfg="virtualMode">
                </div>
                <div class="ab-field">
                    <label>Virtual Balance</label>
                    <input type="number" data-cfg="virtualBalance">
                </div>
                <div class="ab-field">
                    <label>Loop Delay (ms)</label>
                    <input type="number" data-cfg="loopDelayMs">
                </div>
            </div>

            <!-- STRATEGY TAB -->
            <div class="ab-tabpane" data-pane="strategy">
                <div class="ab-field">
                    <label>Strategy</label>
                    <select data-cfg="strategy">
                        <option value="BS_ORDER">BS Order</option>
                        <option value="CUSTOM_PATTERN">Custom Pattern</option>
                        <option value="TREND_FOLLOW">Trend Follow</option>
                        <option value="ALTERNATE">Alternate</option>
                        <option value="AI_PREDICTION">AI Prediction</option>
                        <option value="DREAM">Dream</option>
                        <option value="BABIO">Babio</option>
                        <option value="LEO">Leo</option>
                        <option value="ALINKAR">Alinkar</option>
                        <option value="MAY_BARANI">May Barani</option>
                        <option value="BEATRIX">Beatrix</option>
                        <option value="SNIPER">Sniper</option>
                    </select>
                </div>
                <div class="ab-field">
                    <label>BS Pattern</label>
                    <input data-cfg="bsPattern" placeholder="BSBSBSBSBS">
                </div>
                <div class="ab-field">
                    <label>Custom Pattern</label>
                    <input data-cfg="customBetPattern" placeholder="B,S,B,B,S">
                </div>
                <div class="ab-field">
                    <label>Trend Wait</label>
                    <input type="number" min="0" max="9" data-cfg="trendWaitCount">
                </div>
                <div class="ab-field">
                    <label>Alt Wait</label>
                    <input type="number" min="0" max="9" data-cfg="alternateWaitCount">
                </div>
            </div>

            <!-- BET TAB -->
            <div class="ab-tabpane" data-pane="bet">
                <div class="ab-field">
                    <label>Betting Method</label>
                    <select data-cfg="bettingStrategy">
                        <option value="Martingale">Martingale</option>
                        <option value="Anti-Martingale">Anti-Martingale</option>
                        <option value="D'Alembert">D'Alembert</option>
                        <option value="Custom">Custom</option>
                    </select>
                </div>
                <div class="ab-field">
                    <label>Bet Wrager (comma)</label>
                    <input data-cfg="betSizes" placeholder="100,300,500,900">
                </div>
                <div class="ab-hint">
                    💡 Martingale: lose ရင် index တက်၊ win ရင် reset<br>
                    💡 D'Alembert: unit × wrager (လုံးတစ်ခုတည်း)
                </div>
            </div>

            <!-- RISK TAB -->
            <div class="ab-tabpane" data-pane="risk">
                <div class="ab-field">
                    <label>Target Profit</label>
                    <input type="number" data-cfg="targetProfit">
                </div>
                <div class="ab-field">
                    <label>Stop Loss</label>
                    <input type="number" data-cfg="stopLoss">
                </div>
                <div class="ab-field">
                    <label>Entry Layer</label>
                    <select data-cfg="entryLayer">
                        <option value="1">1 — Direct</option>
                        <option value="2">2 — Wait 1 Lose</option>
                        <option value="3">3 — Wait 2 Loses</option>
                    </select>
                </div>
                <div class="ab-field">
                    <label>SL Layer</label>
                    <select data-cfg="slLayer">
                        <option value="0">Disabled</option>
                        <option value="1">1</option>
                        <option value="2">2</option>
                        <option value="3">3</option>
                        <option value="4">4</option>
                        <option value="5">5</option>
                    </select>
                </div>
            </div>

            <!-- LOG TAB -->
            <div class="ab-tabpane" data-pane="log">
                <div class="ab-stats">
                    <div class="ab-stat"><b>Balance</b><span data-el="st-balance">—</span></div>
                    <div class="ab-stat"><b>Profit</b><span data-el="st-profit">—</span></div>
                    <div class="ab-stat"><b>Wins</b><span data-el="st-wins">0</span></div>
                    <div class="ab-stat"><b>Losses</b><span data-el="st-losses">0</span></div>
                    <div class="ab-stat"><b>Ratio</b><span data-el="st-ratio">—</span></div>
                    <div class="ab-stat"><b>Streak</b><span data-el="st-streak">—</span></div>
                    <div class="ab-stat"><b>Last</b><span data-el="st-last">—</span></div>
                </div>
                <div class="ab-log" data-el="log"></div>
                <div class="ab-btns">
                    <button class="ab-btn ab-btn-ghost" data-el="copyLogBtn">📋 Copy</button>
                    <button class="ab-btn ab-btn-ghost" data-el="clearLogBtn">🗑 Clear</button>
                </div>
            </div>

        </div>

        <div class="ab-footer">
            <button class="ab-btn ab-btn-save" data-el="saveBtn">💾 Save</button>
            <button class="ab-btn ab-btn-run" data-el="runBtn">▶ Run</button>
            <button class="ab-btn ab-btn-stop" data-el="stopBtn" disabled>■ Stop</button>
        </div>
    `;

    /* ── CSS ─────────────────────────────────────────────────── */
    const CSS = `
        #autobet-pro-root, #autobet-pro-root * {
            box-sizing: border-box;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            -webkit-tap-highlight-color: transparent;
        }
        #autobet-pro-root .ab-fab {
            position: fixed; right: 12px; bottom: 12px; z-index: 2147483646;
            display: flex; align-items: center; gap: 6px;
            background: linear-gradient(135deg, #f43f5e 0%, #a855f7 100%);
            color: #fff; padding: 10px 16px; border-radius: 30px;
            font-weight: 700; font-size: 13px; letter-spacing: .5px;
            cursor: pointer; user-select: none;
            box-shadow: 0 6px 20px rgba(244,63,94,.45), 0 2px 6px rgba(0,0,0,.3);
            transition: transform .15s ease;
        }
        #autobet-pro-root .ab-fab:active { transform: scale(.96); }
        #autobet-pro-root .ab-fab-ico { font-size: 16px; }

        #autobet-pro-root .ab-panel {
            position: fixed; z-index: 2147483646;
            left: 0; right: 0; bottom: 0;
            max-height: 88vh;
            background: #0b1120;
            color: #e2e8f0;
            border-radius: 18px 18px 0 0;
            box-shadow: 0 -12px 40px rgba(0,0,0,.6);
            display: flex; flex-direction: column;
            transform: translateY(110%);
            transition: transform .28s cubic-bezier(.32,.72,0,1);
            overflow: hidden;
            font-size: 13px;
            border-top: 1px solid #1e293b;
        }
        #autobet-pro-root .ab-panel.open { transform: translateY(0); }

        @media (min-width: 720px) {
            #autobet-pro-root .ab-panel {
                left: auto; right: 18px; bottom: 70px;
                width: 400px; max-height: 80vh;
                border-radius: 14px;
                border: 1px solid #1e293b;
                transform: translateY(20px);
                opacity: 0; pointer-events: none;
                transition: opacity .2s, transform .2s;
            }
            #autobet-pro-root .ab-panel.open { transform: translateY(0); opacity: 1; pointer-events: auto; }
        }

        #autobet-pro-root .ab-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 12px 14px 10px;
            border-bottom: 1px solid #1e293b;
            flex-shrink: 0;
        }
        #autobet-pro-root .ab-title {
            display: flex; align-items: center; gap: 8px;
            font-weight: 700; font-size: 13px; letter-spacing: .8px;
            color: #f1f5f9;
        }
        #autobet-pro-root .ab-dot {
            width: 8px; height: 8px; border-radius: 50%;
            background: #f43f5e;
            box-shadow: 0 0 8px #f43f5e;
        }
        #autobet-pro-root .ab-status {
            display: inline-block;
            padding: 2px 8px; border-radius: 10px;
            font-size: 9px; font-weight: 800; letter-spacing: 1px;
        }
        #autobet-pro-root .ab-status.running {
            background: #16a34a; color: #fff;
            animation: ab-pulse 1.5s ease-in-out infinite;
        }
        #autobet-pro-root .ab-status.stopped { background: #334155; color: #cbd5e1; }
        @keyframes ab-pulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(22,163,74,.6); }
            50% { box-shadow: 0 0 0 6px rgba(22,163,74,0); }
        }
        #autobet-pro-root .ab-close {
            cursor: pointer; color: #64748b; font-size: 18px;
            width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
            border-radius: 8px; transition: all .15s;
        }
        #autobet-pro-root .ab-close:hover { background: #1e293b; color: #f43f5e; }

        #autobet-pro-root .ab-token-warn {
            background: linear-gradient(90deg, #7f1d1d, #991b1b);
            color: #fecaca; padding: 8px 14px; font-size: 11px;
            border-bottom: 1px solid #991b1b;
            display: none; flex-shrink: 0;
        }
        #autobet-pro-root .ab-token-warn.show { display: block; }

        #autobet-pro-root .ab-tabs {
            display: flex; padding: 6px 8px 0; gap: 2px;
            border-bottom: 1px solid #1e293b;
            overflow-x: auto; flex-shrink: 0;
            scrollbar-width: none;
        }
        #autobet-pro-root .ab-tabs::-webkit-scrollbar { display: none; }
        #autobet-pro-root .ab-tab {
            flex: 0 0 auto;
            padding: 8px 12px;
            font-size: 11.5px; font-weight: 600;
            color: #64748b; cursor: pointer;
            border-radius: 8px 8px 0 0;
            white-space: nowrap;
            transition: all .15s;
            border-bottom: 2px solid transparent;
        }
        #autobet-pro-root .ab-tab:active { background: #1e293b; }
        #autobet-pro-root .ab-tab.active {
            color: #f43f5e;
            border-bottom-color: #f43f5e;
            background: linear-gradient(180deg, transparent, rgba(244,63,94,.08));
        }

        #autobet-pro-root .ab-body {
            flex: 1; overflow-y: auto;
            padding: 14px;
            -webkit-overflow-scrolling: touch;
        }
        #autobet-pro-root .ab-body::-webkit-scrollbar { width: 4px; }
        #autobet-pro-root .ab-body::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }

        #autobet-pro-root .ab-tabpane { display: none; }
        #autobet-pro-root .ab-tabpane.active { display: block; animation: ab-fadein .2s; }
        @keyframes ab-fadein { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

        #autobet-pro-root .ab-field {
            display: flex; align-items: center;
            gap: 10px; margin-bottom: 10px;
        }
        #autobet-pro-root .ab-field label {
            flex: 0 0 112px;
            font-size: 11.5px; color: #94a3b8; font-weight: 500;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        #autobet-pro-root .ab-field input,
        #autobet-pro-root .ab-field select {
            flex: 1; min-width: 0;
            background: #1e293b; color: #e2e8f0;
            border: 1px solid #334155; border-radius: 8px;
            padding: 9px 10px;
            font-size: 13px; outline: none;
            transition: border-color .15s, background .15s;
            font-family: inherit;
        }
        #autobet-pro-root .ab-field input:focus,
        #autobet-pro-root .ab-field select:focus {
            border-color: #f43f5e;
            background: #1a2438;
        }
        #autobet-pro-root .ab-field input[type="checkbox"] {
            flex: 0 0 auto; width: 22px; height: 22px;
            accent-color: #16a34a; cursor: pointer;
            padding: 0; margin: 0;
        }
        #autobet-pro-root .ab-switch label { color: #e2e8f0; }

        #autobet-pro-root .ab-hint {
            font-size: 11px; color: #64748b;
            background: #0f172a; padding: 10px 12px;
            border-radius: 8px; line-height: 1.6;
            border-left: 3px solid #f43f5e; margin-top: 8px;
        }

        #autobet-pro-root .ab-stats {
            display: grid; grid-template-columns: 1fr 1fr;
            gap: 8px; margin-bottom: 10px;
        }
        #autobet-pro-root .ab-stat {
            display: flex; justify-content: space-between; align-items: center;
            background: #0f172a; padding: 8px 10px;
            border-radius: 8px; border: 1px solid #1e293b;
            font-size: 12px;
        }
        #autobet-pro-root .ab-stat b { color: #64748b; font-weight: 500; font-size: 11px; }
        #autobet-pro-root .ab-stat span { color: #e2e8f0; font-weight: 600; }
        #autobet-pro-root .ab-stat span.ok { color: #4ade80; }
        #autobet-pro-root .ab-stat span.err { color: #f87171; }

        #autobet-pro-root .ab-log {
            height: 220px; overflow-y: auto;
            background: #020617; border: 1px solid #1e293b;
            border-radius: 10px; padding: 10px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: 11px; line-height: 1.55;
        }
        #autobet-pro-root .ab-log::-webkit-scrollbar { width: 4px; }
        #autobet-pro-root .ab-log::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }
        #autobet-pro-root .ab-line { white-space: pre-wrap; word-break: break-word; }
        #autobet-pro-root .ab-line.ok { color: #4ade80; }
        #autobet-pro-root .ab-line.err { color: #f87171; }
        #autobet-pro-root .ab-line.warn { color: #fbbf24; }
        #autobet-pro-root .ab-line.info { color: #93c5fd; }

        #autobet-pro-root .ab-footer {
            display: flex; gap: 8px;
            padding: 10px 14px;
            padding-bottom: max(10px, env(safe-area-inset-bottom));
            border-top: 1px solid #1e293b;
            background: #0b1120;
            flex-shrink: 0;
        }
        #autobet-pro-root .ab-btn {
            flex: 1;
            padding: 11px 8px;
            border: none; border-radius: 10px;
            font-weight: 700; font-size: 12.5px;
            cursor: pointer; letter-spacing: .3px;
            transition: all .15s;
            font-family: inherit;
        }
        #autobet-pro-root .ab-btn:active:not(:disabled) { transform: scale(.97); }
        #autobet-pro-root .ab-btn:disabled { opacity: .35; cursor: not-allowed; }
        #autobet-pro-root .ab-btn-save { background: #1e293b; color: #cbd5e1; }
        #autobet-pro-root .ab-btn-save:hover:not(:disabled) { background: #334155; }
        #autobet-pro-root .ab-btn-run {
            background: linear-gradient(135deg, #16a34a, #15803d);
            color: #fff;
            box-shadow: 0 4px 12px rgba(22,163,74,.35);
        }
        #autobet-pro-root .ab-btn-run:hover:not(:disabled) { box-shadow: 0 6px 16px rgba(22,163,74,.5); }
        #autobet-pro-root .ab-btn-stop {
            background: linear-gradient(135deg, #dc2626, #b91c1c);
            color: #fff;
            box-shadow: 0 4px 12px rgba(220,38,38,.35);
        }
        #autobet-pro-root .ab-btn-ghost {
            background: #1e293b; color: #94a3b8;
            font-size: 11px; padding: 8px;
        }
        #autobet-pro-root .ab-btn-ghost:hover { background: #334155; color: #e2e8f0; }

        #autobet-pro-root .ab-btns {
            display: flex; gap: 8px; margin-top: 8px;
        }

        @media (max-width: 380px) {
            #autobet-pro-root .ab-field label { flex: 0 0 96px; font-size: 11px; }
            #autobet-pro-root .ab-body { padding: 12px; }
            #autobet-pro-root .ab-tab { padding: 7px 10px; font-size: 11px; }
        }
    `;

    /* ══════════════════════════════════════════════════════════
     * 11. INIT
     * ══════════════════════════════════════════════════════════ */
    function init() {
        if (!document.body) { document.addEventListener('DOMContentLoaded', init); return; }
        UI.build();
        window.__AUTOBET_PRO__ = { ui: UI, state: S, cfg, log, start: () => UI.startRun(), stop };
        console.log('%c[AUTOBET PRO] ready — click 🤖 button', 'color:#f43f5e;font-weight:bold;font-size:13px');
    }

    init();
})();