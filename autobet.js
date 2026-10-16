/* ============================================================
 * 6Lottery Autobet — Professional Panel
 * Single-file floating UI + strategy engine
 * Usage:
 *   Console:  fetch('URL').then(r=>r.text()).then(eval)
 *   Bookmark: javascript:(()=>fetch('URL').then(r=>r.text()).then(eval))()
 *   Tamper:   // ==UserScript== ... @match site ... 
 * ============================================================ */
(function AUTOBET_PRO() {
    'use strict';

    /* ── Prevent double-inject ─────────────────────────────── */
    if (window.__AUTOBET_PRO__) {
        window.__AUTOBET_PRO__.panel.classList.add('open');
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
        autoRefreshToken: true,
        colorBet: 'G',
        customBetPattern: 'B,S,B,B,S',
        dreamMapEnabled: true,
        leoBigPattern: 'BBSBBSBBSB',
        leoSmallPattern: 'SSBSSBSSBS',
        trendWaitCount: 0,
        alternateWaitCount: 0
    };

    const LS_KEY = 'autobet_pro_cfg_v2';
    const LS_LOG = 'autobet_pro_log_v2';

    let cfg = Object.assign({}, DEFAULT_CFG, safeJSON(localStorage.getItem(LS_KEY)) || {});

    function safeJSON(s) { try { return JSON.parse(s); } catch (e) { return null; } }

    /* ══════════════════════════════════════════════════════════
     * 2. STATE
     * ══════════════════════════════════════════════════════════ */
    const S = {
        running: false,
        stopRequested: false,
        token: null,
        tokenHeader: '',
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

        // strategy state
        patternIdx: 0,
        customPatternIdx: 0,
        martinIndex: 0,
        dalembertUnits: 1,
        customIdx: 0,
        consecutiveLosses: 0,
        skipMode: false,
        entryLayerState: { waiting: false, lossStreak: 0 },
        slSkipWaitingWin: false,
        sniper: { active: false, dir: null, idx: 0, seq: [], hits: 0, sameResult: false },
        dream: { first: true, pattern: null, idx: 0 },
        leo: { idx: 0 },
        babio: { pos: 8 },
        beatrix: { waiting: true, period: null },
        colorTrend: { last: null },
        trendState: { last: null, skip: false },
        altState: { last: null, skip: false },

        // history buffers
        lastResults: [],   // ['B','S',...] recent first
        lastNumbers: [],   // ['0'...'9']
        lastColors: [],    // ['G','V','R']
        rawHistory: []     // full result objects recent first
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
        if (UI.logEl) {
            const d = document.createElement('div');
            d.className = 'ab-line ' + cls;
            d.textContent = `[${line.t}] ${msg}`;
            UI.logEl.appendChild(d);
            UI.logEl.scrollTop = UI.logEl.scrollHeight;
            while (UI.logEl.children.length > 300) UI.logEl.removeChild(UI.logEl.firstChild);
        }
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
        // fallback: window globals
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
     * 5. API LAYER
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
                'Authorization': (S.tokenHeader || '') + S.token,
                'Ar-Origin': S.origin,
                'Origin': S.origin,
                'Referer': S.origin + '/'
            },
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

    function typeIdFor(gameType) {
        return ({ TRX: 13, WINGO: 1, WINGO_30S: 30, WINGO_3MIN: 2, WINGO_5MIN: 3 })[gameType] || 1;
    }
    function issueEndpoint(gameType) {
        return gameType === 'TRX' ? 'GetTrxGameIssue' : 'GetGameIssue';
    }
    function betEndpoint(gameType) {
        return gameType === 'TRX' ? 'GameTrxBetting' : 'GameBetting';
    }

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
     * 6. STRATEGY ENGINE
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
        // list is newest first from API
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
                const ch = p[S.patternIdx % p.length];
                return { ch, advance: true };
            }

            case 'CUSTOM_PATTERN': {
                const items = cfg.customBetPattern.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
                if (!items.length) return { ch: 'B', advance: true };
                return { ch: items[S.customPatternIdx % items.length], advance: true };
            }

            case 'TREND_FOLLOW': {
                if (cfg.betType === 'COLOR') {
                    if (!S.colorTrend.last) {
                        const pick = ['G', 'V', 'R'][Math.floor(Math.random() * 3)];
                        return { ch: pick, advance: true };
                    }
                    return { ch: S.colorTrend.last, advance: true };
                }
                // BS trend: wait filter
                if (cfg.trendWaitCount > 0) {
                    const need = cfg.trendWaitCount * 2;
                    if (last.length >= need) {
                        const tail = last.slice(-need).join('');
                        const bs = 'BS'.repeat(cfg.trendWaitCount);
                        const sb = 'SB'.repeat(cfg.trendWaitCount);
                        if (tail === bs || tail === sb) {
                            S.trendState.skip = true;
                        } else {
                            S.trendState.skip = false;
                        }
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
                        if (tail === bb || tail === ss) {
                            S.altState.skip = true;
                        } else {
                            S.altState.skip = false;
                        }
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
                const window10 = last.slice(-10);
                const counts = { B: 0, S: 0 };
                window10.forEach(r => counts[r]++);
                const last3 = window10.slice(-3).join('');
                if (last3 === 'BBB') return { ch: 'S', advance: true };
                if (last3 === 'SSS') return { ch: 'B', advance: true };
                if (counts.B === counts.S) return { ch: last[last.length - 1], advance: true };
                return { ch: counts.B > counts.S ? 'B' : 'S', advance: true };
            }

            case 'BABIO': {
                if (!last.length) return { ch: 'B', advance: true };
                const pos = S.babio.pos;
                const idx = last.length - pos;
                if (idx >= 0) return { ch: last[idx], advance: true };
                return { ch: last[last.length - 1], advance: true };
            }

            case 'DREAM': {
                if (!S.dream.pattern) {
                    S.dream.first = false;
                    return { ch: 'B', advance: true };
                }
                if (S.dream.idx >= S.dream.pattern.length) S.dream.idx = 0;
                return { ch: S.dream.pattern[S.dream.idx], advance: true };
            }

            case 'LEO': {
                if (!last.length) return { ch: 'B', advance: true };
                const lastRes = last[last.length - 1];
                const pattern = lastRes === 'B' ? cfg.leoBigPattern : cfg.leoSmallPattern;
                const ch = pattern[S.leo.idx % pattern.length];
                return { ch, advance: true };
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
                return { ch: sn.seq[sn.idx], advance: true, sniper: true };
            }

            default:
                return { ch: 'B', advance: true };
        }
    }

    function postBetState(choice, isWin, num, issue) {
        // Update per-strategy internal state after result
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

        if (strat === 'LEO') {
            S.leo.idx++;
        }

        if (strat === 'BABIO') {
            if (!isWin) S.babio.pos = S.babio.pos === 8 ? 5 : 8;
        }

        if (strat === 'BEATRIX') {
            if (num === '7') {
                S.beatrix.waiting = false;
                S.beatrix.period = issue;
            } else {
                S.beatrix.waiting = true;
            }
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
                    log('🏁 SNIPER 2/2 — stopping bot', 'ok');
                    S.stopRequested = true;
                }
            } else {
                S.sniper.idx++;
                if (S.sniper.idx >= 4) {
                    log('❌ SNIPER max bets reached — stopping', 'err');
                    S.stopRequested = true;
                }
            }
        }
    }

    /* ══════════════════════════════════════════════════════════
     * 7. BETTING SIZE (Martingale / Anti / D'Alembert / Custom)
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
                if (isWin) S.customIdx = Math.max(0, S.customIdx - 1);
                else S.customIdx = Math.min(len - 1, S.customIdx + 1);
                break;
        }
    }

    /* ══════════════════════════════════════════════════════════
     * 8. ENTRY LAYER + SL LAYER
     * ══════════════════════════════════════════════════════════ */
    function shouldSkipByEntryLayer() {
        if (cfg.entryLayer === 1) return false;
        if (cfg.entryLayer === 2) {
            return S.entryLayerState.waiting;
        }
        if (cfg.entryLayer === 3) {
            return S.entryLayerState.waiting;
        }
        return false;
    }

    function updateEntryLayer(isWin) {
        if (cfg.entryLayer === 2) {
            if (isWin) S.entryLayerState.waiting = true;
            else S.entryLayerState.waiting = false;
        } else if (cfg.entryLayer === 3) {
            if (isWin) {
                S.entryLayerState.waiting = true;
                S.entryLayerState.lossStreak = 0;
            } else {
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
                log(`SL Layer: ${cfg.slLayer} consecutive losses — skip until win`, 'warn');
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
            stop();
            return;
        }
        log('🔑 Token OK', 'ok');

        // initial balance
        if (cfg.virtualMode) {
            S.balance = cfg.virtualBalance;
        } else {
            try { S.balance = await fetchBalance(); } catch (e) { S.balance = null; }
        }
        if (S.balance === null || isNaN(S.balance)) {
            log('❌ Balance fetch failed', 'err');
            stop();
            return;
        }
        S.startBalance = S.balance;
        S.profit = 0;
        log(`💳 Start balance: ${S.balance.toFixed(2)}`, 'info');

        // seed history
        const seed = await fetchResults();
        if (Array.isArray(seed) && seed.length) {
            seedResults(seed);
            log(`📊 Seeded ${seed.length} results`, 'info');
        }

        // reset per-run state
        S.lastIssue = null;
        S.consecutiveErrors = 0;
        S.wins = 0;
        S.losses = 0;

        let lastWarnTime = 0;

        while (S.running && !S.stopRequested) {
            try {
                // refresh balance
                if (cfg.virtualMode) {
                    S.balance = cfg.virtualBalance;
                } else {
                    const b = await fetchBalance();
                    if (b !== null) S.balance = b;
                }
                S.profit = S.balance - S.startBalance;
                updateStats();

                // stop conditions
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
                // balance warning
                if (!cfg.virtualMode && S.balance < minBet * cfg.balanceWarnRatio) {
                    const now = Date.now();
                    if (now - lastWarnTime > 60000) {
                        log(`⚠️ Low balance: ${S.balance.toFixed(2)}`, 'warn');
                        lastWarnTime = now;
                    }
                }

                // current issue
                const issue = await fetchIssue();
                if (!issue || issue === S.lastIssue) {
                    await sleep(1000);
                    continue;
                }

                // determine choice
                let choice, skip = false, skipReason = '';

                if (shouldSkipByEntryLayer()) {
                    skip = true;
                    skipReason = 'Entry Layer';
                } else if (shouldSkipBySL()) {
                    skip = true;
                    skipReason = 'SL Layer';
                } else {
                    const dec = nextChoice();
                    if (dec.skip) {
                        skip = true;
                        skipReason = dec.reason || 'Strategy Wait';
                    } else {
                        choice = dec.ch;
                    }
                }

                // fallback for skip-choice recording
                if (skip && !choice) {
                    choice = S.lastResults[S.lastResults.length - 1] || 'B';
                }

                if (!choice) {
                    await sleep(1000);
                    continue;
                }

                const map = selectMap();
                const selectType = map[choice];
                if (!selectType) {
                    log(`❌ Invalid choice: ${choice}`, 'err');
                    await sleep(1500);
                    continue;
                }

                const amount = currentBetAmount();
                const unitAmount = amount;
                const betCount = 1;

                // display
                const shortIssue = issue.slice(-5);
                const displayChoice = cfg.betType === 'COLOR' ? colorName(choice) : (choice === 'B' ? 'BIG' : 'SMALL');

                if (skip) {
                    log(`⏭️ SKIP ${shortIssue} — ${skipReason}`, 'warn');
                    S.lastIssue = issue;
                    // wait for result to advance
                    await waitForResult(issue);
                    await sleep(cfg.loopDelayMs);
                    continue;
                }

                log(`🎯 BET ${shortIssue} — ${displayChoice} ${amount}Ks`, 'info');

                let resp;
                if (cfg.virtualMode) {
                    resp = { code: 0, _virtual: true };
                } else {
                    resp = await placeBet(issue, selectType, unitAmount, betCount);
                }

                if (!resp._virtual && resp.code !== 0) {
                    log(`❌ Bet failed: ${resp.msg || resp.error || 'unknown'}`, 'err');
                    S.consecutiveErrors++;
                    if (S.consecutiveErrors >= cfg.maxConsecutiveErrors) {
                        log('Too many consecutive errors — stop', 'err');
                        break;
                    }
                    await sleep(2000);
                    continue;
                }

                S.consecutiveErrors = 0;
                S.lastIssue = issue;

                // wait for result
                const settled = await waitForResult(issue);
                if (!settled) {
                    log(`⏱️ Result timeout ${shortIssue}`, 'warn');
                    continue;
                }

                const num = String(parseInt(settled.number, 10) % 10);
                const bs = numberToBS(num);
                const color = numberToColor(num);

                let isWin;
                if (cfg.betType === 'COLOR') isWin = choice === color;
                else isWin = choice === bs;

                // update history + strategy state
                pushResult(num, bs, color, issue);
                postBetState(choice, isWin, num, issue);
                updateEntryLayer(isWin);
                updateSL(isWin);
                updateBetting(isWin);

                // balance / profit
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
                updateStats();

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
        if (UI.runBtn) UI.runBtn.disabled = false;
        if (UI.stopBtn) UI.stopBtn.disabled = true;
        if (UI.statusEl) {
            UI.statusEl.textContent = 'STOPPED';
            UI.statusEl.className = 'ab-status stopped';
        }
        updateStats();
    }

    /* ══════════════════════════════════════════════════════════
     * 10. UI
     * ══════════════════════════════════════════════════════════ */
    const UI = {};

    function buildUI() {
        const root = document.createElement('div');
        root.id = 'autobet-pro-root';
        document.body.appendChild(root);

        const style = document.createElement('style');
        style.textContent = `
            #autobet-pro-root * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
            #autobet-pro-root .ab-fab {
                position: fixed; right: 18px; bottom: 18px; z-index: 2147483646;
                background: linear-gradient(135deg,#e94560,#533483);
                color:#fff; padding: 12px 20px; border-radius: 32px;
                font-weight: 700; cursor: pointer; box-shadow: 0 6px 24px rgba(0,0,0,.45);
                font-size: 14px; user-select: none; letter-spacing: .3px;
                transition: transform .15s;
            }
            #autobet-pro-root .ab-fab:hover { transform: scale(1.06); }
            #autobet-pro-root .ab-panel {
                position: fixed; right: 18px; bottom: 76px; z-index: 2147483646;
                width: 400px; max-height: 82vh; overflow-y: auto;
                background: #0b1120; color:#e2e8f0;
                border: 1px solid #1e293b; border-radius: 14px;
                box-shadow: 0 20px 60px rgba(0,0,0,.7);
                padding: 16px; font-size: 13px; display: none;
            }
            #autobet-pro-root .ab-panel.open { display: block; }
            #autobet-pro-root .ab-panel::-webkit-scrollbar { width: 6px; }
            #autobet-pro-root .ab-panel::-webkit-scrollbar-thumb { background:#334155; border-radius:3px; }
            #autobet-pro-root h3 {
                margin: 0 0 12px; color:#f43f5e; font-size: 15px;
                display:flex; align-items:center; justify-content:space-between;
                padding-bottom: 10px; border-bottom: 1px solid #1e293b;
            }
            #autobet-pro-root .ab-close {
                cursor:pointer; color:#94a3b8; font-size: 22px; line-height: 1;
                padding: 0 6px; border-radius: 4px;
            }
            #autobet-pro-root .ab-close:hover { color:#f43f5e; background:#1e293b; }
            #autobet-pro-root .ab-status {
                display:inline-block; padding: 3px 10px; border-radius: 12px;
                font-size: 10px; font-weight: 700; letter-spacing: .8px;
                vertical-align: middle; margin-left: 8px;
            }
            #autobet-pro-root .ab-status.running { background:#16a34a; color:#fff; }
            #autobet-pro-root .ab-status.stopped { background:#334155; color:#cbd5e1; }
            #autobet-pro-root .ab-section {
                margin: 10px 0; padding: 10px; background:#0f172a;
                border-radius: 10px; border: 1px solid #1e293b;
            }
            #autobet-pro-root .ab-section h4 {
                margin: 0 0 8px; color:#94a3b8; font-size: 11px;
                text-transform: uppercase; letter-spacing: 1px;
            }
            #autobet-pro-root .ab-row {
                display:flex; align-items:center; gap:8px; margin-bottom: 6px;
            }
            #autobet-pro-root .ab-row label {
                flex: 0 0 120px; color:#94a3b8; font-size: 12px;
            }
            #autobet-pro-root .ab-row input,
            #autobet-pro-root .ab-row select {
                flex: 1; background:#1e293b; color:#e2e8f0;
                border: 1px solid #334155; border-radius: 6px;
                padding: 6px 8px; font-size: 12px; outline: none;
                min-width: 0;
            }
            #autobet-pro-root .ab-row input:focus,
            #autobet-pro-root .ab-row select:focus { border-color: #f43f5e; }
            #autobet-pro-root .ab-row input[type="checkbox"] {
                flex: 0 0 auto; width: 18px; height: 18px; accent-color:#16a34a;
            }
            #autobet-pro-root .ab-btns {
                display:flex; gap: 8px; margin-top: 12px;
            }
            #autobet-pro-root .ab-btns button {
                flex:1; padding: 10px 8px; border:none; border-radius: 8px;
                font-weight: 700; cursor: pointer; font-size: 12px;
                transition: all .15s; letter-spacing: .3px;
            }
            #autobet-pro-root button:disabled { opacity: .4; cursor: not-allowed; }
            #autobet-pro-root .ab-run { background:#16a34a; color:#fff; }
            #autobet-pro-root .ab-run:hover:not(:disabled) { background:#15803d; }
            #autobet-pro-root .ab-stop { background:#dc2626; color:#fff; }
            #autobet-pro-root .ab-stop:hover:not(:disabled) { background:#b91c1c; }
            #autobet-pro-root .ab-save { background:#2563eb; color:#fff; }
            #autobet-pro-root .ab-save:hover { background:#1d4ed8; }
            #autobet-pro-root .ab-reset { background:#475569; color:#fff; }
            #autobet-pro-root .ab-reset:hover { background:#334155; }
            #autobet-pro-root .ab-stats {
                display:grid; grid-template-columns: 1fr 1fr; gap: 6px 12px;
                font-size: 12px; line-height: 1.5;
            }
            #autobet-pro-root .ab-stats span { display:flex; justify-content: space-between; }
            #autobet-pro-root .ab-stats b { color:#94a3b8; font-weight:500; }
            #autobet-pro-root .ab-log {
                height: 200px; overflow-y:auto; background:#020617;
                border-radius: 8px; padding: 8px; margin-top: 8px;
                font-family: ui-monospace, Menlo, Consolas, monospace;
                font-size: 11px; line-height: 1.5;
                border: 1px solid #1e293b;
            }
            #autobet-pro-root .ab-log::-webkit-scrollbar { width:6px; }
            #autobet-pro-root .ab-log::-webkit-scrollbar-thumb { background:#334155; border-radius:3px; }
            #autobet-pro-root .ab-line { white-space: pre-wrap; word-break: break-word; }
            #autobet-pro-root .ab-line.ok { color:#4ade80; }
            #autobet-pro-root .ab-line.err { color:#f87171; }
            #autobet-pro-root .ab-line.warn { color:#fbbf24; }
            #autobet-pro-root .ab-line.info { color:#93c5fd; }
            #autobet-pro-root .ab-token-warn {
                background:#7f1d1d; color:#fecaca; padding: 6px 10px;
                border-radius: 6px; font-size: 11px; margin-bottom: 8px;
                display:none;
            }
            #autobet-pro-root .ab-token-warn.show { display:block; }
            #autobet-pro-root .ab-mini-stats {
                display:flex; gap: 12px; font-size: 11px;
                color: #94a3b8; padding: 6px 0;
            }
            #autobet-pro-root .ab-mini-stats b { color:#e2e8f0; }
        `;
        root.appendChild(style);

        const fab = document.createElement('div');
        fab.className = 'ab-fab';
        fab.textContent = '🤖 AUTOBET';
        root.appendChild(fab);

        const panel = document.createElement('div');
        panel.className = 'ab-panel';
        panel.innerHTML = `
            <h3>
                🤖 AUTOBET PRO
                <span>
                    <span class="ab-status stopped" data-el="status">STOPPED</span>
                    <span class="ab-close" data-el="close">×</span>
                </span>
            </h3>

            <div class="ab-token-warn" data-el="tokenWarn">
                ⚠️ No token found — please log in to the site first
            </div>

            <div class="ab-section">
                <h4>Game</h4>
                <div class="ab-row">
                    <label>Site</label>
                    <select data-cfg="site">
                        <option value="6Lottery">6Lottery</option>
                        <option value="777BIGWIN">777BIGWIN</option>
                    </select>
                </div>
                <div class="ab-row">
                    <label>Game Type</label>
                    <select data-cfg="gameType">
                        <option value="TRX">TRX 1min</option>
                        <option value="WINGO">WINGO 1min</option>
                        <option value="WINGO_30S">WINGO 30s</option>
                        <option value="WINGO_3MIN">WINGO 3min</option>
                        <option value="WINGO_5MIN">WINGO 5min</option>
                    </select>
                </div>
                <div class="ab-row">
                    <label>Bet Type</label>
                    <select data-cfg="betType">
                        <option value="BS">Big / Small</option>
                        <option value="COLOR">Color</option>
                    </select>
                </div>
            </div>

            <div class="ab-section">
                <h4>Strategy</h4>
                <div class="ab-row">
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
                <div class="ab-row">
                    <label>BS Pattern</label>
                    <input data-cfg="bsPattern" placeholder="BSBSBSBSBS">
                </div>
                <div class="ab-row">
                    <label>Custom Pattern</label>
                    <input data-cfg="customBetPattern" placeholder="B,S,B,B,S">
                </div>
                <div class="ab-row">
                    <label>Trend Wait</label>
                    <input data-cfg="trendWaitCount" type="number" min="0" max="9">
                </div>
                <div class="ab-row">
                    <label>Alt Wait</label>
                    <input data-cfg="alternateWaitCount" type="number" min="0" max="9">
                </div>
            </div>

            <div class="ab-section">
                <h4>Betting Strategy</h4>
                <div class="ab-row">
                    <label>Method</label>
                    <select data-cfg="bettingStrategy">
                        <option value="Martingale">Martingale</option>
                        <option value="Anti-Martingale">Anti-Martingale</option>
                        <option value="D'Alembert">D'Alembert</option>
                        <option value="Custom">Custom</option>
                    </select>
                </div>
                <div class="ab-row">
                    <label>Bet Wrager</label>
                    <input data-cfg="betSizes" placeholder="100,300,500,900">
                </div>
            </div>

            <div class="ab-section">
                <h4>Risk Control</h4>
                <div class="ab-row">
                    <label>Target Profit</label>
                    <input data-cfg="targetProfit" type="number">
                </div>
                <div class="ab-row">
                    <label>Stop Loss</label>
                    <input data-cfg="stopLoss" type="number">
                </div>
                <div class="ab-row">
                    <label>Entry Layer</label>
                    <select data-cfg="entryLayer">
                        <option value="1">1 — Direct Bet</option>
                        <option value="2">2 — Wait 1 Lose</option>
                        <option value="3">3 — Wait 2 Loses</option>
                    </select>
                </div>
                <div class="ab-row">
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

            <div class="ab-section">
                <h4>Mode</h4>
                <div class="ab-row">
                    <label>Virtual Mode</label>
                    <input data-cfg="virtualMode" type="checkbox">
                </div>
                <div class="ab-row">
                    <label>Virtual Balance</label>
                    <input data-cfg="virtualBalance" type="number">
                </div>
                <div class="ab-row">
                    <label>Loop Delay (ms)</label>
                    <input data-cfg="loopDelayMs" type="number">
                </div>
            </div>

            <div class="ab-btns">
                <button class="ab-save" data-el="saveBtn">💾 Save</button>
                <button class="ab-run" data-el="runBtn">▶ Run</button>
                <button class="ab-stop" data-el="stopBtn" disabled>■ Stop</button>
            </div>
            <div class="ab-btns" style="margin-top:8px">
                <button class="ab-reset" data-el="resetBtn">🔄 Reset Stats</button>
                <button class="ab-reset" data-el="clearLogBtn">🗑 Clear Log</button>
            </div>

            <div class="ab-section" style="margin-top:10px">
                <h4>Live Stats</h4>
                <div class="ab-stats">
                    <span><b>Balance</b><span data-el="st-balance">—</span></span>
                    <span><b>Profit</b><span data-el="st-profit">—</span></span>
                    <span><b>Wins</b><span data-el="st-wins">0</span></span>
                    <span><b>Losses</b><span data-el="st-losses">0</span></span>
                    <span><b>W/L Ratio</b><span data-el="st-ratio">—</span></span>
                    <span><b>Streak</b><span data-el="st-streak">—</span></span>
                </div>
                <div class="ab-log" data-el="log"></div>
            </div>
        `;
        root.appendChild(panel);

        // refs
        UI.root = root;
        UI.fab = fab;
        UI.panel = panel;
        UI.statusEl = panel.querySelector('[data-el="status"]');
        UI.logEl = panel.querySelector('[data-el="log"]');
        UI.runBtn = panel.querySelector('[data-el="runBtn"]');
        UI.stopBtn = panel.querySelector('[data-el="stopBtn"]');
        UI.saveBtn = panel.querySelector('[data-el="saveBtn"]');
        UI.resetBtn = panel.querySelector('[data-el="resetBtn"]');
        UI.clearLogBtn = panel.querySelector('[data-el="clearLogBtn"]');
        UI.tokenWarn = panel.querySelector('[data-el="tokenWarn"]');
        UI.statEls = {
            balance: panel.querySelector('[data-el="st-balance"]'),
            profit: panel.querySelector('[data-el="st-profit"]'),
            wins: panel.querySelector('[data-el="st-wins"]'),
            losses: panel.querySelector('[data-el="st-losses"]'),
            ratio: panel.querySelector('[data-el="st-ratio"]'),
            streak: panel.querySelector('[data-el="st-streak"]')
        };

        // wire
        fab.addEventListener('click', () => panel.classList.toggle('open'));
        panel.querySelector('[data-el="close"]').addEventListener('click', () => panel.classList.remove('open'));

        UI.saveBtn.addEventListener('click', () => {
            readConfigFromUI();
            log('💾 Settings saved', 'ok');
        });
        UI.runBtn.addEventListener('click', startRun);
        UI.stopBtn.addEventListener('click', () => {
            log('⏹ Stop requested', 'warn');
            S.stopRequested = true;
            S.running = false;
        });
        UI.resetBtn.addEventListener('click', () => {
            S.wins = 0; S.losses = 0; S.profit = 0; S.history = [];
            updateStats();
            log('🔄 Stats reset', 'warn');
        });
        UI.clearLogBtn.addEventListener('click', () => {
            UI.logEl.innerHTML = '';
            S.logs = [];
        });

        // detect token every 5s and warn
        setInterval(() => {
            if (S.running) return;
            const t = findToken();
            UI.tokenWarn.classList.toggle('show', !t);
        }, 5000);

        writeConfigToUI();
        updateStats();
        log('Panel ready. Login to site, then click ▶ Run', 'info');
    }

    function writeConfigToUI() {
        UI.panel.querySelectorAll('[data-cfg]').forEach(el => {
            const key = el.dataset.cfg;
            const v = cfg[key];
            if (el.type === 'checkbox') el.checked = !!v;
            else if (key === 'betSizes') el.value = (v || []).join(',');
            else el.value = v ?? '';
        });
    }

    function readConfigFromUI() {
        UI.panel.querySelectorAll('[data-cfg]').forEach(el => {
            const key = el.dataset.cfg;
            let v;
            if (el.type === 'checkbox') v = el.checked;
            else if (el.type === 'number') v = parseFloat(el.value) || 0;
            else v = el.value;
            if (key === 'betSizes') {
                v = String(v).split(',').map(x => parseInt(x.trim(), 10)).filter(n => !isNaN(n) && n > 0);
                if (!v.length) v = [100];
            }
            if (key === 'entryLayer' || key === 'slLayer') v = parseInt(v, 10);
            if (key === 'trendWaitCount' || key === 'alternateWaitCount') v = parseInt(v, 10) || 0;
            cfg[key] = v;
        });
        localStorage.setItem(LS_KEY, JSON.stringify(cfg));
    }

    function updateStats() {
        if (!UI.statEls) return;
        UI.statEls.balance.textContent = S.balance !== null ? S.balance.toFixed(2) : '—';
        UI.statEls.profit.textContent = (S.profit >= 0 ? '+' : '') + (S.profit || 0).toFixed(2);
        UI.statEls.wins.textContent = S.wins;
        UI.statEls.losses.textContent = S.losses;
        const total = S.wins + S.losses;
        UI.statEls.ratio.textContent = total ? `${S.wins}/${total}` : '—';
        // current streak
        let streak = 0, lastWin = null;
        for (const h of S.history) {
            if (lastWin === null) { lastWin = h.isWin; streak = 1; }
            else if (h.isWin === lastWin) streak++;
            else break;
        }
        UI.statEls.streak.textContent = lastWin === null ? '—' : (lastWin ? `+${streak}W` : `-${streak}L`);
    }

    function startRun() {
        if (S.running) return;
        readConfigFromUI();
        // reset run state
        S.running = true;
        S.stopRequested = false;
        S.wins = 0; S.losses = 0; S.profit = 0; S.history = [];
        S.martinIndex = 0; S.dalembertUnits = 1; S.customIdx = 0;
        S.patternIdx = 0; S.customPatternIdx = 0;
        S.consecutiveLosses = 0; S.skipMode = false; S.slSkipWaitingWin = false;
        S.entryLayerState = { waiting: cfg.entryLayer > 1, lossStreak: 0 };
        S.sniper = { active: false, dir: null, idx: 0, seq: [], hits: 0, sameResult: false };
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

        UI.runBtn.disabled = true;
        UI.stopBtn.disabled = false;
        UI.statusEl.textContent = 'RUNNING';
        UI.statusEl.className = 'ab-status running';
        updateStats();

        ensureMd5().then(() => mainLoop()).catch(e => {
            log('❌ MD5 load failed: ' + e.message, 'err');
            stop();
        });
    }

    /* ══════════════════════════════════════════════════════════
     * 11. INIT
     * ══════════════════════════════════════════════════════════ */
    function init() {
        if (!document.body) {
            document.addEventListener('DOMContentLoaded', init);
            return;
        }
        buildUI();
        window.__AUTOBET_PRO__ = { panel: UI.panel, state: S, cfg, log, start: startRun, stop };
        console.log('%c[AUTOBET PRO] ready — click 🤖 button', 'color:#f43f5e;font-weight:bold');
    }

    init();
})();