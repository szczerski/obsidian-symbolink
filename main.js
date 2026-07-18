'use strict';

var obsidian = require('obsidian');

/* ───────────────────────────────────────────
   Constants
   ─────────────────────────────────────────── */

const BOX_INTERVALS = [0, 1, 3, 7, 14, 30, 60]; // days per box level
const DEFAULT_SETTINGS = {
    cardsPerSession: 20,
    showNodes: true,
    showTags: true,
    showImage: true,
    showAlias: true,
    imageOnlyCards: true,
    fuzzyMatch: true,
    filterFolder: '',
    filterLang: '',
    filterField: '',
    dailyGoalNewCards: 30,
    dailyGoalReviews: 50,
};

/* ───────────────────────────────────────────
   Helpers
   ─────────────────────────────────────────── */

function toLocalString(d) {
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function today() {
    return toLocalString(new Date());
}

function daysBetween(a, b) {
    const d1 = new Date(a);
    const d2 = new Date(b);
    return Math.floor((d2 - d1) / 86400000);
}

function normalize(str) {
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\u0142/g, 'l')
        .trim();
}

function checkAnswer(given, expected, fuzzy) {
    const options = expected.split('|').map(s => s.trim());
    if (fuzzy) {
        return options.some(opt => normalize(given) === normalize(opt));
    }
    return options.some(opt => given.trim() === opt);
}

function generateDiffHtml(given, expected) {
    const options = expected.split('|').map(s => s.trim());
    const givenTrim = given.trim();
    let expectedMatch = options[0];
    for (const opt of options) {
        if (normalize(givenTrim) === normalize(opt)) {
            expectedMatch = opt;
            break;
        }
    }
    const expectedTrim = expectedMatch;

    if (normalize(givenTrim) === normalize(expectedTrim)) {
        return `<span class="symbolink-diff-correct">${given}</span>`;
    }
    
    let html = '';
    const maxLen = Math.max(givenTrim.length, expectedTrim.length);
    for (let i = 0; i < maxLen; i++) {
        const gChar = givenTrim[i];
        const eChar = expectedTrim[i];
        
        if (gChar && eChar) {
            if (normalize(gChar) === normalize(eChar)) {
                html += `<span class="symbolink-diff-correct">${gChar}</span>`;
            } else {
                html += `<span class="symbolink-diff-incorrect">${gChar}</span>`;
            }
        } else if (gChar) {
            html += `<span class="symbolink-diff-incorrect">${gChar}</span>`;
        } else {
            html += `<span class="symbolink-diff-missing">_</span>`;
        }
    }
    return html;
}

function getCount(entry) {
    if (!entry) return 0;
    if (typeof entry === 'number') return entry;
    if (typeof entry === 'object') {
        return (entry.correct || 0) + (entry.incorrect || 0);
    }
    return 0;
}

function calculateStreaks(history) {
    const activeDates = Object.keys(history || {})
        .filter(dateStr => getCount(history[dateStr]) > 0)
        .sort();

    if (activeDates.length === 0) {
        return { current: 0, longest: 0, average: 0 };
    }

    const parseDateToDayIndex = (dateStr) => {
        const [year, month, day] = dateStr.split('-').map(Number);
        const date = new Date(Date.UTC(year, month - 1, day));
        return Math.floor(date.getTime() / 86400000);
    };

    const dayIndices = activeDates.map(parseDateToDayIndex);

    const streaks = [];
    let currentStreakLength = 1;

    for (let i = 1; i < dayIndices.length; i++) {
        if (dayIndices[i] === dayIndices[i - 1] + 1) {
            currentStreakLength++;
        } else {
            streaks.push(currentStreakLength);
            currentStreakLength = 1;
        }
    }
    streaks.push(currentStreakLength);

    const longest = Math.max(...streaks);
    const average = Math.round(streaks.reduce((a, b) => a + b, 0) / streaks.length * 10) / 10;

    const todayStr = today();
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const yesterdayStr = toLocalString(d);

    const hasToday = getCount(history[todayStr]) > 0;
    const hasYesterday = getCount(history[yesterdayStr]) > 0;

    let current = 0;
    if (hasToday || hasYesterday) {
        let checkDate = hasToday ? new Date() : d;
        while (true) {
            const checkStr = toLocalString(checkDate);
            if (getCount(history[checkStr]) > 0) {
                current++;
                checkDate.setDate(checkDate.getDate() - 1);
            } else {
                break;
            }
        }
    }

    return { current, longest, average };
}

/* ───────────────────────────────────────────
   Card builder
   ─────────────────────────────────────────── */

async function buildCards(app, settings) {
    const cards = [];
    const files = app.vault.getMarkdownFiles();

    for (const file of files) {
        if (settings.filterFolder && !file.path.startsWith(settings.filterFolder)) {
            continue;
        }

        const cache = app.metadataCache.getFileCache(file);
        
        // Exclude files marked with a _category tag from study
        if (cache) {
            let hasCategory = false;
            if (cache.frontmatter && cache.frontmatter.tags) {
                const fmTags = cache.frontmatter.tags || [];
                const tagList = Array.isArray(fmTags) ? fmTags : [fmTags];
                hasCategory = tagList.some(t => String(t).replace(/^#/, '').startsWith('_category/'));
            }
            if (!hasCategory && cache.tags) {
                hasCategory = cache.tags.some(t => t.tag.replace(/^#/, '').startsWith('_category/'));
            }
            if (hasCategory) continue;
        }

        // --- Frontmatter based cards ---
        if (cache && cache.frontmatter) {
            const fm = cache.frontmatter;
            const answer = file.basename;

            const fmTags = fm.tags || [];
            const tagList = Array.isArray(fmTags) ? fmTags : [fmTags];

            // collect hints
            const nodes = fm.nodes ? (Array.isArray(fm.nodes) ? fm.nodes : String(fm.nodes).split(/[\s,]+/)) : [];
            const tags = fm.tags ? (Array.isArray(fm.tags) ? fm.tags : [fm.tags]).map(t => String(t).replace(/^#/, '')).filter(t => !t.startsWith('_')) : [];
            const imageRaw = fm.image || null;
            const image = Array.isArray(imageRaw) ? (imageRaw[0] || null) : imageRaw;
            const aliases = fm.alias || fm.aliases || [];
            const aliasList = Array.isArray(aliases) ? aliases : [aliases];

            let langTags = [];
            let fieldTags = [];
            for (const t of tagList) {
                const s = String(t).replace(/^#/, '');
                if (s.startsWith('_lang/')) langTags.push(s.replace('_lang/', ''));
                if (s.startsWith('_field/')) fieldTags.push(s.replace('_field/', ''));
            }
            if (cache.tags) {
                for (const t of cache.tags) {
                    const s = t.tag.replace(/^#/, '');
                    if (s.startsWith('_lang/') && !langTags.includes(s.replace('_lang/', ''))) langTags.push(s.replace('_lang/', ''));
                    if (s.startsWith('_field/') && !fieldTags.includes(s.replace('_field/', ''))) fieldTags.push(s.replace('_field/', ''));
                }
            }

            const hasHints = nodes.length > 0 || tags.length > 0 || image;

            if (hasHints) {
                cards.push({
                    id: file.path,
                    answer: answer,
                    nodes: nodes,
                    tags: tags,
                    image: image,
                    langTags: langTags,
                    fieldTags: fieldTags,
                    type: 'standard',
                    mtime: file.stat.mtime,
                    ctime: file.stat.ctime,
                });
            }

            // Image-only cards: show only image, answer is filename
            if (image && settings.imageOnlyCards) {
                cards.push({
                    id: file.path + '::image',
                    answer: answer,
                    image: image,
                    langTags: langTags,
                    fieldTags: fieldTags,
                    type: 'image_only',
                    mtime: file.stat.mtime,
                    ctime: file.stat.ctime,
                });
            }

            // Alias cards: show alias, answer is filename
            for (const al of aliasList) {
                if (!al) continue;
                cards.push({
                    id: file.path + '::alias::' + al,
                    answer: answer,
                    aliasHint: String(al),
                    nodes: [],
                    tags: [],
                    image: null,
                    langTags: langTags,
                    fieldTags: fieldTags,
                    type: 'alias_to_name',
                    mtime: file.stat.mtime,
                    ctime: file.stat.ctime,
                });
            }
        }
        
        // --- Callout quiz cards ---
        const content = await app.vault.read(file);
        const lines = content.split(/\r?\n/);

        let currentCard = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Match callout header: > [!category]- Question
            const calloutMatch = line.match(/^>\s*\[!([a-zA-Z]+)\]-\s*(.+)$/);

            if (calloutMatch) {
                const rawCategory = calloutMatch[1];
                
                // Exclude "note" callouts from being processed as study cards
                if (rawCategory.toLowerCase() === 'note') {
                    currentCard = null;
                    continue;
                }

                const isLanguage = rawCategory.length === 2;
                const formattedCategory = isLanguage ? rawCategory.toUpperCase() : rawCategory;

                currentCard = {
                    id: `${file.path}::line::${i}`,
                    sourcePath: file.path,
                    category: formattedCategory,
                    question: calloutMatch[2].trim(),
                    answer: '',
                    type: 'callout_quiz',
                    fieldTags: isLanguage ? [] : [formattedCategory], // Map non-languages to field tag for filtering
                    langTags: isLanguage ? [formattedCategory] : [],   // Map languages to lang tags
                    mtime: file.stat.mtime,
                    ctime: file.stat.ctime,
                };
                continue;
            }

            // If we found a header, look for [[answer]] in subsequent lines
            if (currentCard) {
                if (line.trim().startsWith('>')) {
                    const answerMatch = line.match(/\[\[(.+?)\]\]/);
                    if (answerMatch) {
                        currentCard.answer = answerMatch[1].trim();
                        const safeQuestion = currentCard.question.toLowerCase().replace(/[^a-z0-9]+/g, '_').substring(0, 30);
                        currentCard.id = `${currentCard.answer}::${file.basename}::${safeQuestion}`;
                        cards.push(currentCard);
                        currentCard = null; // Card is complete, reset
                    }
                } else {
                    // If line doesn't start with '>', we've left the callout block
                    currentCard = null;
                }
            }
        }
    }

    return cards;
}

/* ───────────────────────────────────────────
   Card selector (spaced repetition)
   ─────────────────────────────────────────── */

function selectCards(cards, reviewData, count) {
    const now = today();
    const scored = cards.map(card => {
        const data = reviewData[card.id];
        if (!data) {
            return { card, score: -10000 + Math.random() };
        }
        const interval = BOX_INTERVALS[Math.min(data.box, BOX_INTERVALS.length - 1)];
        const daysSince = daysBetween(data.lastReview, now);
        const overdueDays = daysSince - interval;
        const errorRate = data.incorrect / (data.correct + data.incorrect + 1);
        return { card, score: -overdueDays - errorRate * 5 + Math.random() * 0.1 };
    });

    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, count).map(s => s.card);
}

/* ───────────────────────────────────────────
   Session Config Modal
   ─────────────────────────────────────────── */

function collectByPrefix(app, settings, prefix) {
    const values = new Set();
    for (const file of app.vault.getMarkdownFiles()) {
        if (settings.filterFolder && !file.path.startsWith(settings.filterFolder)) continue;
        const cache = app.metadataCache.getFileCache(file);
        if (!cache) continue;
        if (cache.frontmatter) {
            const fmTags = cache.frontmatter.tags || [];
            const tagList = Array.isArray(fmTags) ? fmTags : [fmTags];
            for (const t of tagList) {
                const s = String(t).replace(/^#/, '');
                if (s.startsWith(prefix)) values.add(s.replace(prefix, ''));
            }
        }
        if (cache.tags) {
            for (const t of cache.tags) {
                const s = t.tag.replace(/^#/, '');
                if (s.startsWith(prefix)) values.add(s.replace(prefix, ''));
            }
        }
    }
    return [...values].sort();
}

function collectLanguages(app, settings) { return collectByPrefix(app, settings, '_lang/'); }
function collectFields(app, settings) { return collectByPrefix(app, settings, '_field/'); }

class SessionConfigModal extends obsidian.Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('symbolink-modal');
        this.modalEl.style.width = '800px';
        this.modalEl.style.maxWidth = '90vw';
        this.contentEl.style.maxWidth = '100%'; // Override default 600px constraint

        contentEl.createEl('h2', { text: 'Ustawienia sesji' });

        const s = this.plugin.settings;
        let count = s.cardsPerSession;
        let filterLang = s.filterLang || '';
        let filterField = s.filterField || '';
        let includeStandard = false;
        let includeImageOnly = false;
        let includeAlias = false;
        let includeCallouts = true;
        let filterModified = 'all';

        const allCards = await buildCards(this.app, s);
        const langSet = new Set();
        const fieldSet = new Set();
        
        for (const c of allCards) {
            c.langTags.forEach(t => langSet.add(t));
            c.fieldTags.forEach(t => fieldSet.add(t));
        }
        const languages = [...langSet].sort();
        const fields = [...fieldSet].sort();

        // Cards count
        new obsidian.Setting(contentEl)
            .setName('Karty')
            .setDesc('Liczba fiszek do powtórki')
            .addSlider(slider => slider
                .setLimits(5, 100, 5)
                .setValue(count)
                .setDynamicTooltip()
                .onChange(v => count = v));

        new obsidian.Setting(contentEl)
            .setName('Zakres czasowy kart')
            .setDesc('Filtruj karty po dacie ostatniej modyfikacji notatki')
            .addDropdown(drop => drop
                .addOption('all', 'Wszystkie')
                .addOption('today', 'Dzisiaj')
                .addOption('yesterday', 'Wczoraj')
                .addOption('3days', 'Ostatnie 3 dni')
                .addOption('7days', 'Ostatnie 7 dni')
                .addOption('30days', 'Ostatnie 30 dni')
                .addOption('60days', 'Ostatnie 60 dni')
                .addOption('180days', 'Ostatnie 180 dni')
                .addOption('365days', 'Ostatnie 365 dni')
                .setValue(filterModified)
                .onChange(v => filterModified = v)
            );

        // Category filter UI generator
        const makeBtnGroup = (title, current, onChange) => {
            const wrapper = contentEl.createDiv({ cls: 'symbolink-cat-group' });
            wrapper.createEl('div', { text: title, cls: 'symbolink-section-label' });
            const row = wrapper.createDiv({ cls: 'symbolink-cat-buttons' });
            const makeBtn = (label, value) => {
                const btn = row.createEl('button', { text: label, cls: 'symbolink-cat-btn' });
                if (current === value) btn.addClass('symbolink-cat-btn-active');
                btn.addEventListener('click', () => {
                    onChange(value);
                    row.querySelectorAll('.symbolink-cat-btn').forEach(b => b.removeClass('symbolink-cat-btn-active'));
                    btn.addClass('symbolink-cat-btn-active');
                });
            };
            return makeBtn;
        };

        if (languages.length > 0) {
            const makeBtn = makeBtnGroup('Język', filterLang, v => filterLang = v);
            makeBtn('Wszystkie', '');
            for (const l of languages) makeBtn(l, l);
        }

        // Category filter
        if (fields.length > 0) {
            const makeBtn = makeBtnGroup('Kategorie', filterField, v => filterField = v);
            makeBtn('Wszystkie', '');
            for (const f of fields) makeBtn(f, f);
        }

        // Card types
        contentEl.createEl('div', { text: 'Rodzaje kart', cls: 'symbolink-section-label' });

        new obsidian.Setting(contentEl)
            .setName('Standardowe (nodes / tagi)')
            .addToggle(t => t.setValue(includeStandard).onChange(v => includeStandard = v));

        new obsidian.Setting(contentEl)
            .setName('Tylko obrazek')
            .addToggle(t => t.setValue(includeImageOnly).onChange(v => includeImageOnly = v));

        new obsidian.Setting(contentEl)
            .setName('Alias')
            .addToggle(t => t.setValue(includeAlias).onChange(v => includeAlias = v));

        new obsidian.Setting(contentEl)
            .setName('Zakładki (Callouts)')
            .addToggle(t => t.setValue(includeCallouts).onChange(v => includeCallouts = v));

        // Buttons
        const btnRow = contentEl.createDiv({ cls: 'symbolink-buttons' });
        btnRow.style.marginTop = '1rem';

        const startBtn = btnRow.createEl('button', { text: 'Start', cls: 'symbolink-btn symbolink-btn-check' });
        const cancelBtn = btnRow.createEl('button', { text: 'Anuluj', cls: 'symbolink-btn symbolink-btn-skip' });
        const statsBtn = btnRow.createEl('button', { text: 'Statystyki i Heatmapa', cls: 'symbolink-btn' });
        statsBtn.style.marginLeft = 'auto';

        startBtn.addEventListener('click', () => {
            this.close();
            new ReviewModal(this.app, this.plugin, {
                cardsPerSession: count,
                filterLang,
                filterField,
                filterModified,
                includeStandard,
                includeImageOnly,
                includeAlias,
                includeCallouts,
            }).open();
        });

        cancelBtn.addEventListener('click', () => this.close());
        statsBtn.addEventListener('click', () => {
            this.close();
            new StatsModal(this.app, this.plugin).open();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

/* ───────────────────────────────────────────
   Review Modal
   ─────────────────────────────────────────── */

class ReviewModal extends obsidian.Modal {
    constructor(app, plugin, sessionConfig = null) {
        super(app);
        this.plugin = plugin;
        this.sessionConfig = sessionConfig;
        this.cards = [];
        this.currentIndex = 0;
        this.sessionCorrect = 0;
        this.sessionIncorrect = 0;
        this.revealed = false;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('symbolink-modal');

        this.scope.register(['Ctrl', 'Shift'], 'H', (e) => {
            e.preventDefault();
            if (this.hintBtn && this.hintBtn.style.display !== 'none') this.hintBtn.click();
            return false;
        });
        this.scope.register(['Ctrl', 'Shift'], 'T', (e) => {
            e.preventDefault();
            if (this.playBtn && this.playBtn.style.display !== 'none') this.playBtn.click();
            return false;
        });
        this.scope.register(['Ctrl', 'Shift'], 'N', (e) => {
            e.preventDefault();
            if (this.skipBtn && this.skipBtn.style.display !== 'none') this.skipBtn.click();
            return false;
        });

        const sc = this.sessionConfig;
        let allCards = await buildCards(this.app, this.plugin.settings);
        this.allCards = allCards;
        if (sc) {
            const nowMs = Date.now();
            const startOfToday = new Date(nowMs);
            startOfToday.setHours(0, 0, 0, 0);
            const startOfTodayMs = startOfToday.getTime();
            const startOfYesterdayMs = startOfTodayMs - 86400000;

            allCards = allCards.filter(c => {
                if (c.type === 'standard' && !sc.includeStandard) return false;
                if (c.type === 'image_only' && !sc.includeImageOnly) return false;
                if (c.type === 'alias_to_name' && !sc.includeAlias) return false;
                if (c.type === 'callout_quiz' && !sc.includeCallouts) return false;
                if (sc.filterLang && !c.langTags.includes(sc.filterLang)) return false;
                if (sc.filterField && !c.fieldTags.includes(sc.filterField)) return false;
                
                if (sc.filterModified && sc.filterModified !== 'all') {
                    const mtime = c.mtime;
                    if (!mtime) return false;
                    
                    if (sc.filterModified === 'today') {
                        if (mtime < startOfTodayMs) return false;
                    } else if (sc.filterModified === 'yesterday') {
                        if (mtime < startOfYesterdayMs || mtime >= startOfTodayMs) return false;
                    } else if (sc.filterModified === '3days') {
                        if (mtime < startOfTodayMs - 2 * 86400000) return false;
                    } else if (sc.filterModified === '7days') {
                        if (mtime < startOfTodayMs - 6 * 86400000) return false;
                    } else if (sc.filterModified === '30days') {
                        if (mtime < startOfTodayMs - 29 * 86400000) return false;
                    } else if (sc.filterModified === '60days') {
                        if (mtime < startOfTodayMs - 59 * 86400000) return false;
                    } else if (sc.filterModified === '180days') {
                        if (mtime < startOfTodayMs - 179 * 86400000) return false;
                    } else if (sc.filterModified === '365days') {
                        if (mtime < startOfTodayMs - 364 * 86400000) return false;
                    }
                }
                
                return true;
            });
        }
        if (allCards.length === 0) {
            contentEl.createEl('p', { text: 'No cards found. Make sure your notes have frontmatter properties (nodes, tags, image, or alias).' });
            return;
        }

        const sessionCount = sc ? sc.cardsPerSession : this.plugin.settings.cardsPerSession;
        this.cards = selectCards(allCards, this.plugin.data.reviews, sessionCount);
        if (this.cards.length === 0) {
            contentEl.createEl('p', { text: 'All cards are up to date. Come back later.' });
            return;
        }

        this.showCard();
    }

    showCard() {
        const { contentEl } = this;
        contentEl.empty();
        this.revealed = false;

        if (this.currentIndex >= this.cards.length) {
            this.showSummary();
            return;
        }

        const card = this.cards[this.currentIndex];
        const total = this.cards.length;
        const reviewInfo = this.plugin.data.reviews[card.id];

        // Header
        const header = contentEl.createDiv({ cls: 'symbolink-header' });
        header.createEl('span', {
            text: `${this.currentIndex + 1} / ${total}`,
            cls: 'symbolink-counter'
        });
        const statsText = reviewInfo
            ? `box ${reviewInfo.box} · ${reviewInfo.correct}✓ ${reviewInfo.incorrect}✗`
            : 'new card';
        header.createEl('span', { text: statsText, cls: 'symbolink-stats' });

        // Language / field badges
        if ((card.langTags && card.langTags.length > 0) || (card.fieldTags && card.fieldTags.length > 0)) {
            const badgeRow = contentEl.createDiv({ cls: 'symbolink-badges' });
            for (const lt of (card.langTags || [])) {
                badgeRow.createEl('span', { text: lt, cls: 'symbolink-badge symbolink-badge-lang' });
            }
            for (const ft of (card.fieldTags || [])) {
                badgeRow.createEl('span', { text: ft, cls: 'symbolink-badge symbolink-badge-field' });
            }
        }

        // Hint area
        const hintArea = contentEl.createDiv({ cls: 'symbolink-hints' });

        if (card.type === 'callout_quiz') {
            const calloutDiv = hintArea.createDiv({ cls: 'callout symbolink-callout-question' });
            calloutDiv.setAttribute('data-callout', card.category.toLowerCase());
            
            const calloutTitle = calloutDiv.createDiv({ cls: 'callout-title' });
            calloutTitle.createDiv({ cls: 'callout-icon' });
            calloutTitle.createDiv({ cls: 'callout-title-inner', text: card.category });
            
            const qDiv = calloutDiv.createDiv({ cls: 'callout-content symbolink-question' });
            
            let questionText = card.question;
            const imgMatches = [...questionText.matchAll(/!\[\[(.+?)\]\]/g)];
            for (const m of imgMatches) {
                questionText = questionText.replace(m[0], '').trim();
                try {
                    const parts = m[1].split('|');
                    const imgPath = parts[0];
                    const sizeStr = parts[1];
                    const imgFile = this.app.metadataCache.getFirstLinkpathDest(imgPath, '');
                    if (imgFile) {
                        const imgEl = qDiv.createEl('img', { cls: 'symbolink-image' });
                        imgEl.src = this.app.vault.getResourcePath(imgFile);
                        if (sizeStr) {
                            if (sizeStr.includes('x')) {
                                const [w, h] = sizeStr.split('x');
                                imgEl.style.width = w + 'px';
                                imgEl.style.height = h + 'px';
                                imgEl.style.maxHeight = 'none';
                            } else {
                                imgEl.style.width = sizeStr + 'px';
                                imgEl.style.maxHeight = 'none';
                            }
                        }
                    }
                } catch (e) {}
            }
            
            qDiv.createEl('div', { text: questionText, cls: 'symbolink-question-text' });
        } else if (card.type === 'alias_to_name') {
            hintArea.createEl('div', { text: card.aliasHint, cls: 'symbolink-alias-hint' });
            hintArea.createEl('div', { text: 'alias → filename', cls: 'symbolink-hint-label' });
        } else if (card.type === 'image_only') {
            try {
                const linkContent = card.image.replace(/^!?\[\[(.+)\]\]$/, '$1');
                const parts = linkContent.split('|');
                const imgPath = parts[0];
                const sizeStr = parts[1];
                const imgFile = this.app.metadataCache.getFirstLinkpathDest(imgPath, '');
                if (imgFile) {
                    const imgEl = hintArea.createEl('img', { cls: 'symbolink-image' });
                    imgEl.src = this.app.vault.getResourcePath(imgFile);
                    if (sizeStr) {
                        if (sizeStr.includes('x')) {
                            const [w, h] = sizeStr.split('x');
                            imgEl.style.width = w + 'px';
                            imgEl.style.height = h + 'px';
                            imgEl.style.maxHeight = 'none';
                        } else {
                            imgEl.style.width = sizeStr + 'px';
                            imgEl.style.maxHeight = 'none';
                        }
                    }
                    imgEl.onerror = () => {
                        imgEl.remove();
                        hintArea.createEl('div', { text: '(image not found)', cls: 'symbolink-label' });
                    };
                } else {
                    hintArea.createEl('div', { text: '(image not found)', cls: 'symbolink-label' });
                }
            } catch (e) {
                hintArea.createEl('div', { text: '(image error)', cls: 'symbolink-label' });
            }
        } else {
            if (card.image && this.plugin.settings.showImage) {
                try {
                    const linkContent = card.image.replace(/^!?\[\[(.+)\]\]$/, '$1');
                    const parts = linkContent.split('|');
                    const imgPath = parts[0];
                    const sizeStr = parts[1];
                    const imgFile = this.app.metadataCache.getFirstLinkpathDest(imgPath, '');
                    if (imgFile) {
                        const imgEl = hintArea.createEl('img', { cls: 'symbolink-image' });
                        imgEl.src = this.app.vault.getResourcePath(imgFile);
                        if (sizeStr) {
                            if (sizeStr.includes('x')) {
                                const [w, h] = sizeStr.split('x');
                                imgEl.style.width = w + 'px';
                                imgEl.style.height = h + 'px';
                                imgEl.style.maxHeight = 'none';
                            } else {
                                imgEl.style.width = sizeStr + 'px';
                                imgEl.style.maxHeight = 'none';
                            }
                        }
                    }
                } catch (e) { /* skip image on error */ }
            }

            if (card.nodes.length > 0 && this.plugin.settings.showNodes) {
                const nodesDiv = hintArea.createDiv({ cls: 'symbolink-nodes' });
                nodesDiv.createEl('span', { text: 'nodes: ', cls: 'symbolink-label' });
                nodesDiv.createEl('span', { text: card.nodes.join(' · ') });
            }

            if (card.tags.length > 0 && this.plugin.settings.showTags) {
                const tagsDiv = hintArea.createDiv({ cls: 'symbolink-tags' });
                tagsDiv.createEl('span', { text: 'tags: ', cls: 'symbolink-label' });
                tagsDiv.createEl('span', { text: card.tags.join(' · ') });
            }
        }

        // Hint display
        let lettersRevealed = 0;
        let hintUsed = false;
        const primaryAnswer = card.answer.split('|')[0].trim();

        // Input
        const inputArea = contentEl.createDiv({ cls: 'symbolink-input-area' });
        const hintEl = inputArea.createDiv({ cls: 'symbolink-hint-letters' });
        hintEl.style.display = 'none';
        const input = inputArea.createEl('input', {
            type: 'text',
            placeholder: 'Wpisz swoją odpowiedź...',
            cls: 'symbolink-input',
        });

        const updateHintEl = () => {
            hintEl.style.display = 'block';
            hintEl.setText(
                primaryAnswer.split('').map((c, i) => i < lettersRevealed ? c : '_').join(' ')
            );
        };

        // Feedback (hidden)
        const feedback = contentEl.createDiv({ cls: 'symbolink-feedback' });
        feedback.style.display = 'none';

        // Buttons
        const btnRow = contentEl.createDiv({ cls: 'symbolink-buttons' });
        const checkBtn = btnRow.createEl('button', { text: 'Sprawdź', cls: 'symbolink-btn symbolink-btn-check' });
        const hintBtn = btnRow.createEl('button', { text: 'Podpowiedź', cls: 'symbolink-btn symbolink-btn-hint', title: 'Podpowiedź (Ctrl+Shift+H)' });
        const playBtn = btnRow.createEl('button', { text: '🔊', cls: 'symbolink-btn symbolink-btn-play', title: 'Skopiuj i odtwórz (Ctrl+Shift+T)' });
        this.hintBtn = hintBtn;
        this.playBtn = playBtn;
        const skipBtn = btnRow.createEl('button', { text: 'Pomiń', cls: 'symbolink-btn symbolink-btn-skip', title: 'Pomiń (Ctrl+Shift+N)' });
        this.skipBtn = skipBtn;
        const nextBtn = btnRow.createEl('button', { text: 'Dalej →', cls: 'symbolink-btn symbolink-btn-next' });
        nextBtn.style.display = 'none';
        const overrideBtn = btnRow.createEl('button', { text: 'Jednak dobrze (literówka)', cls: 'symbolink-btn symbolink-btn-override' });
        overrideBtn.style.display = 'none';
        const openBtn = btnRow.createEl('button', { text: 'Otwórz kartę', cls: 'symbolink-btn symbolink-btn-open' });
        openBtn.style.display = 'none';

        hintBtn.addEventListener('click', () => {
            if (this.revealed) return;
            if (lettersRevealed < primaryAnswer.length) lettersRevealed++;
            hintUsed = true;
            updateHintEl();
        });

        playBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(primaryAnswer).catch(() => {});
            const { exec } = require('child_process');
            
            let voice = '-v "Samantha"'; // Domyślny wysokiej jakości amerykański głos
            if (card.langTags && card.langTags.length > 0) {
                const lang = card.langTags[0].toLowerCase();
                if (lang.includes('pl')) voice = '-v "Zosia"';
                else if (lang.includes('gb') || lang.includes('uk')) voice = '-v "Daniel"';
                else if (lang.includes('es')) voice = '-v "Monica"';
                else if (lang.includes('fr')) voice = '-v "Thomas"';
                else if (lang.includes('de')) voice = '-v "Anna"';
                else if (lang.includes('it')) voice = '-v "Alice"';
            }
            
            exec(`killall say 2>/dev/null; say ${voice} ${JSON.stringify(primaryAnswer)}`);
        });

        overrideBtn.addEventListener('click', () => {
            // Wycofaj błąd z sesji i historii
            const t = today();
            if (this.plugin.data.history && this.plugin.data.history[t]) {
                this.plugin.data.history[t].incorrect--;
                this.plugin.data.history[t].correct++;
            }
            this.sessionIncorrect--;
            this.sessionCorrect++;

            // Przywróć stary stan dla karty (lub usuń, jeśli nowa), by recordReview mogło działać "do przodu"
            if (this.oldRevData) {
                this.plugin.data.reviews[card.id] = JSON.parse(JSON.stringify(this.oldRevData));
            } else {
                delete this.plugin.data.reviews[card.id];
            }

            // Zapisz jako poprawne (traktujemy jak odgadnięte z podpowiedziami jeśli były)
            this.recordReview(card.id, true, lettersRevealed);

            // Odśwież UI
            feedback.removeClass('symbolink-incorrect');
            feedback.addClass('symbolink-correct');
            feedback.empty();
            feedback.createEl('div', { text: '✓ Uznano za poprawne', cls: 'symbolink-fb-result' });
            
            const revData = this.plugin.data.reviews[card.id];
            if (revData) {
                const statsEl = feedback.createDiv({ cls: 'symbolink-card-stats-inline' });
                const totalPlays = revData.correct + revData.incorrect;
                const acc = totalPlays > 0 ? Math.round((revData.correct / totalPlays) * 100) : 0;
                statsEl.createEl('div', { text: `📊 Odpowiedzi: ${totalPlays} (Poprawne: ${revData.correct}, Błędne: ${revData.incorrect}) · Trafność: ${acc}%` });
                statsEl.createEl('div', { text: `📦 Pudełko: ${revData.box} · Następna powtórka: ${revData.nextReview}` });
            }

            overrideBtn.style.display = 'none';
        });

        const doCheck = () => {
            if (this.revealed) return;
            this.revealed = true;

            const given = input.value;
            const correct = checkAnswer(given, card.answer, this.plugin.settings.fuzzyMatch);

            this.oldRevData = this.plugin.data.reviews[card.id] ? JSON.parse(JSON.stringify(this.plugin.data.reviews[card.id])) : null;
            let isIncorrect = false;

            feedback.style.display = 'block';
            feedback.empty();

            if (hintUsed) {
                feedback.addClass('symbolink-hint-used');
                feedback.removeClass('symbolink-correct');
                feedback.removeClass('symbolink-incorrect');
                if (correct) {
                    if (lettersRevealed === 1) {
                        feedback.createEl('div', { text: '~ Dobrze (1 podpowiedź)', cls: 'symbolink-fb-result' });
                        this.sessionCorrect++;
                        this.recordReview(card.id, true, lettersRevealed);
                    } else {
                        feedback.createEl('div', { text: `~ Trudne (${lettersRevealed} podpowiedzi)`, cls: 'symbolink-fb-result' });
                        this.sessionCorrect++;
                        this.recordReview(card.id, true, lettersRevealed);
                    }
                } else {
                    isIncorrect = true;
                    feedback.createEl('div', { text: '✗ Błędnie', cls: 'symbolink-fb-result' });
                    feedback.createEl('div', { text: `Odpowiedź: ${card.answer}`, cls: 'symbolink-fb-answer' });
                    if (given.trim() !== '') {
                        const givenDiv = feedback.createDiv({ cls: 'symbolink-fb-given' });
                        givenDiv.innerHTML = `Twoja odpowiedź: ${generateDiffHtml(given, card.answer)}`;
                    }
                    this.sessionIncorrect++;
                    this.recordReview(card.id, false, lettersRevealed);
                }
            } else if (correct) {
                feedback.addClass('symbolink-correct');
                feedback.removeClass('symbolink-incorrect');
                feedback.createEl('div', { text: '✓ Łatwe (Bez podpowiedzi)!', cls: 'symbolink-fb-result' });
                this.sessionCorrect++;
                this.recordReview(card.id, true, 0);
            } else {
                isIncorrect = true;
                feedback.addClass('symbolink-incorrect');
                feedback.removeClass('symbolink-correct');
                feedback.createEl('div', { text: '✗ Błędnie', cls: 'symbolink-fb-result' });
                feedback.createEl('div', { text: `Odpowiedź: ${card.answer}`, cls: 'symbolink-fb-answer' });
                if (given.trim() !== '') {
                    const givenDiv = feedback.createDiv({ cls: 'symbolink-fb-given' });
                    givenDiv.innerHTML = `Twoja odpowiedź: ${generateDiffHtml(given, card.answer)}`;
                }
                this.sessionIncorrect++;
                this.recordReview(card.id, false, 0);
            }
            const revData = this.plugin.data.reviews[card.id];
            if (revData) {
                const statsEl = feedback.createDiv({ cls: 'symbolink-card-stats-inline' });
                const totalPlays = revData.correct + revData.incorrect;
                const acc = totalPlays > 0 ? Math.round((revData.correct / totalPlays) * 100) : 0;
                statsEl.createEl('div', { text: `📊 Odpowiedzi: ${totalPlays} (Poprawne: ${revData.correct}, Błędne: ${revData.incorrect}) · Trafność: ${acc}%` });
                statsEl.createEl('div', { text: `📦 Pudełko: ${revData.box} · Następna powtórka: ${revData.nextReview}` });
            }

            input.readOnly = true;
            checkBtn.style.display = 'none';
            hintBtn.style.display = 'none';
            skipBtn.style.display = 'none';
            if (isIncorrect) overrideBtn.style.display = 'inline-block';
            nextBtn.style.display = 'inline-block';
            openBtn.style.display = 'inline-block';
        };

        checkBtn.addEventListener('click', doCheck);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (!this.revealed) {
                    doCheck();
                } else {
                    this.currentIndex++;
                    this.showCard();
                }
            }
        });

        skipBtn.addEventListener('click', () => {
            this.currentIndex++;
            this.showCard();
        });

        nextBtn.addEventListener('click', () => {
            this.currentIndex++;
            this.showCard();
        });

        openBtn.addEventListener('click', () => {
            let fileToOpen = null;
            if (card.answer) {
                fileToOpen = this.app.metadataCache.getFirstLinkpathDest(card.answer, "");
            }
            if (!fileToOpen) {
                const basePath = card.sourcePath || card.id.split('::')[0];
                fileToOpen = this.app.vault.getAbstractFileByPath(basePath);
            }
            if (fileToOpen) {
                this.app.workspace.getLeaf('tab').openFile(fileToOpen);
            }
        });

        setTimeout(() => input.focus(), 50);
    }

    recordReview(cardId, correct, hints = 0) {
        if (!this.plugin.data.reviews[cardId]) {
            this.plugin.data.reviews[cardId] = {
                box: 0,
                correct: 0,
                incorrect: 0,
                lastReview: today(),
                nextReview: today(),
            };
        }

        const data = this.plugin.data.reviews[cardId];
        data.lastReview = today();

        if (correct) {
            data.correct++;
            if (hints === 0) {
                // Easy: advance
                data.box = Math.min(data.box + 1, BOX_INTERVALS.length - 1);
            } else if (hints === 1) {
                // Good: stay
                data.box = data.box;
            } else {
                // Hard: regress 1 box
                data.box = Math.max(data.box - 1, 0);
            }
        } else {
            data.incorrect++;
            data.box = 0; // Wrong: reset completely
        }

        const interval = BOX_INTERVALS[data.box];
        const next = new Date();
        next.setDate(next.getDate() + interval);
        data.nextReview = next.toISOString().slice(0, 10);

        const t = today();
        if (!this.plugin.data.history) this.plugin.data.history = {};
        if (!this.plugin.data.history[t]) this.plugin.data.history[t] = { correct: 0, incorrect: 0 };
        if (correct) {
            this.plugin.data.history[t].correct++;
        } else {
            this.plugin.data.history[t].incorrect++;
        }

        this.plugin.saveData(this.plugin.data);
        this.plugin.updateStatusBar();
    }

    showSummary() {
        const { contentEl } = this;
        contentEl.empty();

        const total = this.sessionCorrect + this.sessionIncorrect;
        const pct = total > 0 ? Math.round((this.sessionCorrect / total) * 100) : 0;

        const summary = contentEl.createDiv({ cls: 'symbolink-summary' });
        summary.createEl('h2', { text: 'Sesja zakończona' });
        summary.createEl('div', { text: `Poprawne: ${this.sessionCorrect}`, cls: 'symbolink-summary-correct' });
        summary.createEl('div', { text: `Błędne: ${this.sessionIncorrect}`, cls: 'symbolink-summary-incorrect' });
        summary.createEl('div', { text: `Skuteczność: ${pct}%`, cls: 'symbolink-summary-pct' });

        const reviewCount = Object.keys(this.plugin.data.reviews).length;
        const totalCardsCount = this.allCards ? this.allCards.length : 0;
        summary.createEl('div', {
            text: `Wszystkie karty: ${totalCardsCount} · Kiedykolwiek powtórzone: ${reviewCount}`,
            cls: 'symbolink-summary-total'
        });

        const btnRow = contentEl.createDiv({ cls: 'symbolink-buttons' });
        const againBtn = btnRow.createEl('button', { text: 'Jeszcze raz', cls: 'symbolink-btn symbolink-btn-check' });
        againBtn.addEventListener('click', () => {
            this.currentIndex = 0;
            this.sessionCorrect = 0;
            this.sessionIncorrect = 0;
            this.onOpen();
        });

        const closeBtn = btnRow.createEl('button', { text: 'Zamknij', cls: 'symbolink-btn symbolink-btn-skip' });
        closeBtn.addEventListener('click', () => this.close());

        const statsBtn = btnRow.createEl('button', { text: 'Statystyki i Heatmapa', cls: 'symbolink-btn' });
        statsBtn.addEventListener('click', () => {
            this.close();
            new StatsModal(this.app, this.plugin).open();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

/* ───────────────────────────────────────────
   Stats Modal
   ─────────────────────────────────────────── */

class StatsModal extends obsidian.Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('symbolink-modal');

        const reviews = this.plugin.data.reviews;
        const allCards = await buildCards(this.app, this.plugin.settings);
        const now = today();

        let dueCount = 0;
        let newCount = 0;
        let totalCorrect = 0;
        let totalIncorrect = 0;
        const boxCounts = new Array(BOX_INTERVALS.length).fill(0);
        
        let createdTodayCount = 0;
        let modifiedTodayCount = 0;
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayStartMs = todayStart.getTime();

        const catStats = {};

        for (const card of allCards) {
            const data = reviews[card.id];
            
            if (card.ctime >= todayStartMs) {
                createdTodayCount++;
            } else if (card.mtime >= todayStartMs) {
                modifiedTodayCount++;
            }
            
            let cat = card.category || card.fieldTags[0] || 'Brak kategorii';
            if (!card.category && !card.fieldTags[0] && card.langTags[0]) {
                cat = `Język: ${card.langTags[0].toUpperCase()}`;
            }
            if (!catStats[cat]) {
                catStats[cat] = { due: 0, correct: 0, incorrect: 0, total: 0 };
            }
            catStats[cat].total++;

            if (!data) {
                newCount++;
                continue;
            }
            totalCorrect += data.correct;
            totalIncorrect += data.incorrect;
            boxCounts[data.box]++;
            const interval = BOX_INTERVALS[Math.min(data.box, BOX_INTERVALS.length - 1)];
            if (daysBetween(data.lastReview, now) >= interval) {
                dueCount++;
                catStats[cat].due++;
            }
            catStats[cat].correct += data.correct;
            catStats[cat].incorrect += data.incorrect;
        }

        contentEl.createEl('h2', { text: 'Statystyki Symbolink' });

        const todayHist = (this.plugin.data.history || {})[now] || { correct: 0, incorrect: 0 };
        const correctTodayCount = todayHist.correct || 0;
        const incorrectTodayCount = todayHist.incorrect || 0;
        
        contentEl.createEl('h3', { text: 'Cele Dzienne', attr: { style: 'margin-top: 0;' } });
        
        const goalsContainer = contentEl.createDiv({ cls: 'symbolink-goals-container' });
        goalsContainer.style.display = 'flex';
        goalsContainer.style.gap = '20px';
        goalsContainer.style.marginBottom = '25px';
        goalsContainer.style.flexWrap = 'wrap';
        
        const renderGoal = (title, current, target) => {
            const el = goalsContainer.createDiv({ cls: 'symbolink-goal-card' });
            el.style.flex = '1';
            el.style.minWidth = '120px';
            el.style.padding = '15px';
            el.style.border = '1px solid var(--background-modifier-border)';
            el.style.borderRadius = '8px';
            el.style.textAlign = 'center';
            el.style.backgroundColor = 'var(--background-secondary)';
            
            el.createDiv({ text: title, attr: { style: 'font-size: 0.9em; color: var(--text-muted); margin-bottom: 8px;' }});
            
            if (target !== null && target !== undefined) {
                const isCompleted = current >= target;
                const color = isCompleted ? 'var(--text-success)' : 'var(--text-accent)';
                
                el.createDiv({ text: `${current} / ${target}`, attr: { style: `font-size: 1.8em; font-weight: bold; color: ${color}; margin-bottom: 12px;` }});
                
                const barBg = el.createDiv({ attr: { style: 'width: 100%; height: 8px; background: var(--background-modifier-border); border-radius: 4px; overflow: hidden;' }});
                const pct = Math.min(100, target > 0 ? (current / target) * 100 : 100);
                barBg.createDiv({ attr: { style: `width: ${pct}%; height: 100%; background: ${color}; transition: width 0.3s ease;` }});
            } else {
                el.createDiv({ text: `${current}`, attr: { style: `font-size: 1.8em; font-weight: bold; color: var(--text-error); margin-bottom: 12px;` }});
            }
        };
        
        renderGoal('Nowe karty dodane', createdTodayCount, this.plugin.settings.dailyGoalNewCards);
        renderGoal('Zaliczone powtórki', correctTodayCount, this.plugin.settings.dailyGoalReviews);
        renderGoal('Do powtórki (błędy)', incorrectTodayCount, null);

        const { current, longest, average } = calculateStreaks(this.plugin.data.history || {});
        
        const streaksContainer = contentEl.createDiv({ cls: 'symbolink-streaks-container' });
        
        const createStreakCard = (val, lbl) => {
            const card = streaksContainer.createDiv({ cls: 'symbolink-streak-card' });
            card.createDiv({ cls: 'symbolink-streak-val', text: val });
            card.createDiv({ cls: 'symbolink-streak-lbl', text: lbl });
        };
        
        createStreakCard(`🔥 ${current}`, 'Obecna Seria');
        createStreakCard(`🏆 ${longest}`, 'Najdłuższa Seria');
        createStreakCard(`📊 ${average}`, 'Średnia Seria');

        const history = this.plugin.data.history || {};
        const creationHistory = {};
        for (const card of allCards) {
            if (card.ctime) {
                const dateStr = toLocalString(new Date(card.ctime));
                creationHistory[dateStr] = (creationHistory[dateStr] || 0) + 1;
            }
        }

        const todayDate = new Date();
        const start = new Date();
        start.setDate(start.getDate() - 364);
        const dayOfWeek = start.getDay();
        const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        start.setDate(start.getDate() - diffToMonday);
        start.setHours(0, 0, 0, 0);

        const dates = [];
        const currentDt = new Date(start);
        const end = new Date(todayDate);
        end.setHours(23, 59, 59, 999);

        while (currentDt <= end) {
            dates.push(new Date(currentDt));
            currentDt.setDate(currentDt.getDate() + 1);
        }

        const weeks = [];
        let currentWeek = [];
        for (const d of dates) {
            currentWeek.push(d);
            if (currentWeek.length === 7) {
                weeks.push(currentWeek);
                currentWeek = [];
            }
        }
        if (currentWeek.length > 0) {
            while (currentWeek.length < 7) {
                currentWeek.push(null);
            }
            weeks.push(currentWeek);
        }

        const renderHeatmap = (title, dataObj, isCreation) => {
            const heatmapContainer = contentEl.createDiv({ cls: 'symbolink-heatmap-container' });
            
            const heatmapHeader = heatmapContainer.createDiv({ cls: 'symbolink-heatmap-header' });
            heatmapHeader.createEl('h3', { text: title, cls: 'symbolink-heatmap-title' });
            const legend = heatmapHeader.createDiv({ cls: 'symbolink-heatmap-legend' });
            legend.createEl('span', { text: 'Mniej' });
            [0, 1, 2, 3, 4].forEach(lvl => {
                const lCell = legend.createDiv({ cls: `symbolink-heatmap-day level-${lvl}` });
                if (lvl === 0) lCell.addClass('empty');
            });
            legend.createEl('span', { text: 'Więcej' });

            const heatmapScroll = heatmapContainer.createDiv({ cls: 'symbolink-heatmap-scroll' });
            const heatmapGrid = heatmapScroll.createDiv({ cls: 'symbolink-heatmap-grid' });

            for (const week of weeks) {
                const weekCol = heatmapGrid.createDiv({ cls: 'symbolink-heatmap-week' });
                for (const d of week) {
                    const dayCell = weekCol.createDiv({ cls: 'symbolink-heatmap-day' });
                    if (d) {
                        const dateStr = toLocalString(d);
                        let count = 0;
                        if (isCreation) {
                            count = dataObj[dateStr] || 0;
                        } else {
                            count = getCount(dataObj[dateStr]);
                        }
                        
                        dayCell.setAttribute('title', `${dateStr}: ${count} ${isCreation ? 'dodanych kart' : 'powtórek'}`);
                        
                        let level = 0;
                        if (count > 0 && count < 5) level = 1;
                        else if (count >= 5 && count < 10) level = 2;
                        else if (count >= 10 && count < 20) level = 3;
                        else if (count >= 20) level = 4;
                        
                        if (level > 0) {
                            dayCell.addClass(`level-${level}`);
                        } else {
                            dayCell.addClass('empty');
                        }
                    } else {
                        dayCell.addClass('empty');
                        dayCell.style.opacity = '0';
                    }
                }
            }

            setTimeout(() => {
                heatmapScroll.scrollLeft = heatmapScroll.scrollWidth;
            }, 50);
        };

        renderHeatmap('Historia Powtórek', history, false);
        renderHeatmap('Historia Dodanych Kart', creationHistory, true);

        const grid = contentEl.createDiv({ cls: 'symbolink-stats-grid' });

        const addStat = (label, value) => {
            const row = grid.createDiv({ cls: 'symbolink-stat-row' });
            row.createEl('span', { text: label, cls: 'symbolink-stat-label' });
            row.createEl('span', { text: String(value), cls: 'symbolink-stat-value' });
        };

        addStat('Wszystkie karty', allCards.length);
        addStat('Utworzone dzisiaj', createdTodayCount);
        addStat('Zmodyfikowane dzisiaj', modifiedTodayCount);
        addStat('Nowe (nigdy nie powtarzane)', newCount);
        addStat('Na dziś', dueCount);
        addStat('Poprawne odpowiedzi', totalCorrect);
        addStat('Błędne odpowiedzi', totalIncorrect);
        addStat('Skuteczność', totalCorrect + totalIncorrect > 0
            ? Math.round(totalCorrect / (totalCorrect + totalIncorrect) * 100) + '%'
            : 'brak danych');

        contentEl.createEl('h3', { text: 'Wyniki w Kategoriach' });
        const catGrid = contentEl.createDiv({ cls: 'symbolink-stats-grid symbolink-cat-stats-grid' });
        catGrid.style.gridTemplateColumns = '1fr 1fr';
        
        // Sort categories by due (descending), then accuracy (descending), then alphabetically
        const sortedCats = Object.entries(catStats).sort((a, b) => {
            if (b[1].due !== a[1].due) {
                return b[1].due - a[1].due;
            }
            const accA = a[1].correct + a[1].incorrect > 0 ? a[1].correct / (a[1].correct + a[1].incorrect) : -1;
            const accB = b[1].correct + b[1].incorrect > 0 ? b[1].correct / (b[1].correct + b[1].incorrect) : -1;
            if (accB !== accA) {
                return accB - accA;
            }
            return a[0].localeCompare(b[0]);
        });

        const flags = {
            'EN': '🇬🇧', 'ES': '🇪🇸', 'DE': '🇩🇪', 'FR': '🇫🇷', 
            'IT': '🇮🇹', 'PT': '🇵🇹', 'RU': '🇷🇺', 'ZH': '🇨🇳', 
            'JA': '🇯🇵', 'AR': '🇸🇦', 'KO': '🇰🇷', 'PL': '🇵🇱'
        };

        for (const [cat, stats] of sortedCats) {
            if (stats.total === 0) continue;
            
            let displayCat = cat;
            let flagKey = cat;
            if (cat.startsWith('Język: ')) flagKey = cat.replace('Język: ', '');
            if (flags[flagKey]) {
                displayCat = `${flags[flagKey]} ${cat}`;
            }

            const acc = stats.correct + stats.incorrect > 0 
                ? Math.round(stats.correct / (stats.correct + stats.incorrect) * 100) + '%'
                : '-';
            
            const row = catGrid.createDiv({ cls: 'symbolink-stat-row' });
            row.createEl('span', { text: displayCat, cls: 'symbolink-stat-label' });
            row.createEl('span', { text: `Skuteczność: ${acc} | Na dziś: ${stats.due}`, cls: 'symbolink-stat-value' });
        }

        contentEl.createEl('h3', { text: 'Rozkład Pudełek' });
        const boxDiv = contentEl.createDiv({ cls: 'symbolink-box-chart' });
        for (let i = 0; i < BOX_INTERVALS.length; i++) {
            const row = boxDiv.createDiv({ cls: 'symbolink-box-row' });
            row.createEl('span', {
                text: `Pudełko ${i} (${BOX_INTERVALS[i]}d)`,
                cls: 'symbolink-box-label'
            });
            const bar = row.createDiv({ cls: 'symbolink-box-bar-bg' });
            const fill = bar.createDiv({ cls: 'symbolink-box-bar-fill' });
            const maxCount = Math.max(...boxCounts, 1);
            fill.style.width = (boxCounts[i] / maxCount * 100) + '%';
            row.createEl('span', { text: String(boxCounts[i]), cls: 'symbolink-box-count' });
        }

        const btnRow = contentEl.createDiv({ cls: 'symbolink-buttons' });
        btnRow.style.marginTop = '20px';
        const resetBtn = btnRow.createEl('button', {
            text: 'Zresetuj postępy',
            cls: 'symbolink-btn symbolink-btn-skip'
        });
        const browserBtn = btnRow.createEl('button', {
            text: 'Przeglądarka Kart',
            cls: 'symbolink-btn'
        });
        browserBtn.style.marginLeft = '10px';
        browserBtn.addEventListener('click', () => {
            this.close();
            new CardBrowserModal(this.app, this.plugin).open();
        });
        resetBtn.addEventListener('click', () => {
            if (confirm('Czy na pewno chcesz usunąć wszystkie dane powtórek?')) {
                this.plugin.data.reviews = {};
                this.plugin.data.history = {};
                this.plugin.saveData(this.plugin.data);
                new obsidian.Notice('Postępy zresetowane');
                this.onOpen();
            }
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

/* ───────────────────────────────────────────
   Card Browser Modal
   ─────────────────────────────────────────── */

class CardBrowserModal extends obsidian.Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.allCards = [];
        this.sortCol = 'nextReview';
        this.sortAsc = true;
        this.searchQuery = '';
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('symbolink-modal', 'symbolink-browser-modal');
        this.modalEl.style.width = '90vw';
        this.modalEl.style.maxWidth = '1200px';
        this.contentEl.style.maxWidth = '100%';

        const header = contentEl.createDiv({ cls: 'symbolink-header' });
        header.createEl('h2', { text: 'Card Browser' });

        const searchInput = contentEl.createEl('input', {
            type: 'text',
            placeholder: 'Szukaj kart...',
            cls: 'symbolink-browser-search'
        });
        searchInput.style.marginBottom = '15px';
        searchInput.style.width = '100%';
        searchInput.style.padding = '8px';
        searchInput.addEventListener('input', (e) => {
            this.searchQuery = e.target.value.toLowerCase();
            this.renderTable();
        });

        const loading = contentEl.createEl('p', { text: 'Loading cards...' });
        
        this.allCards = await buildCards(this.app, this.plugin.settings);
        
        const answerCounts = {};
        for (const c of this.allCards) {
            const ans = c.answer || '';
            if (ans) {
                answerCounts[ans] = (answerCounts[ans] || 0) + 1;
            }
        }
        
        // Merge with review data
        this.browserCards = this.allCards.map(c => {
            const data = this.plugin.data.reviews[c.id] || {
                box: 0,
                correct: 0,
                incorrect: 0,
                lastReview: '-',
                nextReview: '-'
            };
            
            let q = c.question || c.answer || c.id;
            if (q.length > 50) q = q.substring(0, 50) + '...';
            
            let cat = c.category || c.fieldTags[0] || c.langTags[0] || 'none';
            // Add flag emojis for languages
            const flags = {
                'EN': '🇬🇧 EN', 'ES': '🇪🇸 ES', 'DE': '🇩🇪 DE', 'FR': '🇫🇷 FR', 
                'IT': '🇮🇹 IT', 'PT': '🇵🇹 PT', 'RU': '🇷🇺 RU', 'ZH': '🇨🇳 ZH', 
                'JA': '🇯🇵 JA', 'AR': '🇸🇦 AR', 'KO': '🇰🇷 KO', 'PL': '🇵🇱 PL'
            };
            if (flags[cat]) cat = flags[cat];
            
            return {
                id: c.id,
                type: c.type,
                question: q,
                answer: c.answer || '',
                backlinksCount: c.answer ? (answerCounts[c.answer] || 0) : 0,
                category: cat,
                box: data.box,
                lastReview: data.lastReview,
                nextReview: data.nextReview,
                reviews: data.correct + data.incorrect,
                accuracy: data.correct + data.incorrect > 0 
                    ? Math.round(data.correct / (data.correct + data.incorrect) * 100)
                    : -1, // -1 means no data
                data: data // keep ref to original data
            };
        });

        loading.remove();
        this.renderTable();
    }
    
    renderTable() {
        const { contentEl } = this;
        // remove existing table if any
        const existingTable = contentEl.querySelector('.symbolink-browser-container');
        if (existingTable) existingTable.remove();
        
        const container = contentEl.createDiv({ cls: 'symbolink-browser-container' });
        
        let displayCards = this.browserCards;
        if (this.searchQuery) {
            displayCards = displayCards.filter(c => 
                c.question.toLowerCase().includes(this.searchQuery) ||
                c.category.toLowerCase().includes(this.searchQuery) ||
                c.type.toLowerCase().includes(this.searchQuery)
            );
        }
        
        // Sorting logic
        displayCards.sort((a, b) => {
            let valA = a[this.sortCol];
            let valB = b[this.sortCol];
            
            if (typeof valA === 'string' && typeof valB === 'string') {
                return this.sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
            } else {
                return this.sortAsc ? (valA - valB) : (valB - valA);
            }
        });

        const table = container.createEl('table', { cls: 'symbolink-browser-table' });
        
        // Header
        const thead = table.createEl('thead');
        const tr = thead.createEl('tr');
        
        const cols = [
            { id: 'question', label: 'Pytanie / Nazwa' },
            { id: 'answer', label: 'Baza' },
            { id: 'backlinksCount', label: 'Powiązania' },
            { id: 'type', label: 'Typ' },
            { id: 'category', label: 'Kategoria' },
            { id: 'box', label: 'Pudełko' },
            { id: 'reviews', label: 'Powtórki' },
            { id: 'lastReview', label: 'Ostatnia powtórka' },
            { id: 'nextReview', label: 'Następna powtórka' },
            { id: 'accuracy', label: 'Skuteczność' },
            { id: 'actions', label: '' }
        ];
        
        cols.forEach(col => {
            const th = tr.createEl('th', { text: col.label });
            if (col.id !== 'actions') {
                th.style.cursor = 'pointer';
                if (this.sortCol === col.id) {
                    th.innerText += this.sortAsc ? ' 🔼' : ' 🔽';
                }
                th.addEventListener('click', () => {
                    if (this.sortCol === col.id) {
                        this.sortAsc = !this.sortAsc;
                    } else {
                        this.sortCol = col.id;
                        this.sortAsc = true;
                    }
                    this.renderTable();
                });
            }
        });

        // Body
        const tbody = table.createEl('tbody');
        for (const bc of displayCards) {
            const row = tbody.createEl('tr');
            
            const qTd = row.createEl('td', { text: bc.question, cls: 'symbolink-browser-q' });
            // Make question clickable to open note
            qTd.style.cursor = 'pointer';
            qTd.style.color = 'var(--text-accent)';
            qTd.addEventListener('click', () => {
                const path = bc.id.split('::')[0];
                this.app.workspace.openLinkText(path, '', true);
                this.close();
            });
            
            // Make answer clickable to open note
            const aTd = row.createEl('td', { text: bc.answer, cls: 'symbolink-browser-a' });
            if (bc.answer) {
                aTd.style.cursor = 'pointer';
                aTd.style.color = 'var(--text-accent)';
                aTd.addEventListener('click', () => {
                    let fileToOpen = this.app.metadataCache.getFirstLinkpathDest(bc.answer, "");
                    if (fileToOpen) {
                        this.app.workspace.getLeaf('tab').openFile(fileToOpen);
                    } else {
                        // Fallback to searching by string or just opening link text
                        this.app.workspace.openLinkText(bc.answer, '', true);
                    }
                    this.close();
                });
            }
            row.createEl('td', { text: String(bc.backlinksCount) });
            row.createEl('td', { text: bc.type });
            row.createEl('td', { text: bc.category });
            row.createEl('td', { text: String(bc.box) });
            row.createEl('td', { text: String(bc.reviews) });
            row.createEl('td', { text: bc.lastReview });
            row.createEl('td', { text: bc.nextReview });
            
            const accText = bc.accuracy >= 0 ? bc.accuracy + '%' : '-';
            row.createEl('td', { text: accText });
            
            const actionTd = row.createEl('td');
            if (bc.lastReview !== '-') {
                const resetBtn = actionTd.createEl('button', { text: 'Reset', cls: 'symbolink-btn symbolink-btn-skip' });
                resetBtn.style.padding = '2px 6px';
                resetBtn.style.fontSize = '0.8em';
                resetBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (confirm('Reset progress for this card?')) {
                        delete this.plugin.data.reviews[bc.id];
                        this.plugin.saveData(this.plugin.data);
                        bc.box = 0;
                        bc.lastReview = '-';
                        bc.nextReview = '-';
                        bc.accuracy = -1;
                        this.renderTable();
                    }
                });
            }
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

/* ───────────────────────────────────────────
   Settings Tab
   ─────────────────────────────────────────── */

class SymbolinkSettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Symbolink' });

        new obsidian.Setting(containerEl)
            .setName('Cards per session')
            .setDesc('How many cards to draw for one review session')
            .addText(text => text
                .setValue(String(this.plugin.settings.cardsPerSession))
                .onChange(async (value) => {
                    const n = parseInt(value);
                    if (!isNaN(n) && n > 0) {
                        this.plugin.settings.cardsPerSession = n;
                        await this.plugin.saveSettings();
                    }
                }));

        new obsidian.Setting(containerEl)
            .setName('Daily goal: New cards')
            .setDesc('Target number of newly created cards per day')
            .addText(text => text
                .setValue(String(this.plugin.settings.dailyGoalNewCards))
                .onChange(async (value) => {
                    const n = parseInt(value);
                    if (!isNaN(n) && n >= 0) {
                        this.plugin.settings.dailyGoalNewCards = n;
                        await this.plugin.saveSettings();
                    }
                }));

        new obsidian.Setting(containerEl)
            .setName('Daily goal: Reviews')
            .setDesc('Target number of cards to review per day')
            .addText(text => text
                .setValue(String(this.plugin.settings.dailyGoalReviews))
                .onChange(async (value) => {
                    const n = parseInt(value);
                    if (!isNaN(n) && n >= 0) {
                        this.plugin.settings.dailyGoalReviews = n;
                        await this.plugin.saveSettings();
                    }
                }));

        new obsidian.Setting(containerEl)
            .setName('Show nodes')
            .setDesc('Display nodes property as a hint')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showNodes)
                .onChange(async (value) => {
                    this.plugin.settings.showNodes = value;
                    await this.plugin.saveSettings();
                }));

        new obsidian.Setting(containerEl)
            .setName('Show tags')
            .setDesc('Display tags property as a hint (excludes _ prefixed tags)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showTags)
                .onChange(async (value) => {
                    this.plugin.settings.showTags = value;
                    await this.plugin.saveSettings();
                }));

        new obsidian.Setting(containerEl)
            .setName('Show image')
            .setDesc('Display image property as a visual hint')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showImage)
                .onChange(async (value) => {
                    this.plugin.settings.showImage = value;
                    await this.plugin.saveSettings();
                }));

        new obsidian.Setting(containerEl)
            .setName('Image-only cards')
            .setDesc('Create extra cards where only the image is shown as a hint (requires image property)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.imageOnlyCards)
                .onChange(async (value) => {
                    this.plugin.settings.imageOnlyCards = value;
                    await this.plugin.saveSettings();
                }));

        new obsidian.Setting(containerEl)
            .setName('Fuzzy matching')
            .setDesc('Ignore case and diacritics when checking answers')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.fuzzyMatch)
                .onChange(async (value) => {
                    this.plugin.settings.fuzzyMatch = value;
                    await this.plugin.saveSettings();
                }));

        new obsidian.Setting(containerEl)
            .setName('Filter by folder')
            .setDesc('Folder path (empty = entire vault)')
            .addText(text => text
                .setPlaceholder('e.g. Notes/')
                .setValue(this.plugin.settings.filterFolder)
                .onChange(async (value) => {
                    this.plugin.settings.filterFolder = value;
                    await this.plugin.saveSettings();
                }));

        new obsidian.Setting(containerEl)
            .setName('Default language filter')
            .setDesc('Tag value after _lang/ (empty = all)')
            .addText(text => text
                .setPlaceholder('e.g. EN')
                .setValue(this.plugin.settings.filterLang)
                .onChange(async (value) => {
                    this.plugin.settings.filterLang = value;
                    await this.plugin.saveSettings();
                }));

        new obsidian.Setting(containerEl)
            .setName('Default field filter')
            .setDesc('Tag value after _field/ (empty = all)')
            .addText(text => text
                .setPlaceholder('e.g. architecture')
                .setValue(this.plugin.settings.filterField)
                .onChange(async (value) => {
                    this.plugin.settings.filterField = value;
                    await this.plugin.saveSettings();
                }));
    }
}

/* ───────────────────────────────────────────
   Main Plugin
   ─────────────────────────────────────────── */

class SymbolinkPlugin extends obsidian.Plugin {
    async onload() {
        await this.loadSettings();

        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.addClass('symbolink-status-bar-item');
        this.statusBarItem.style.cursor = 'pointer';
        this.statusBarItem.addEventListener('click', () => {
            new SessionConfigModal(this.app, this).open();
        });
        this.updateStatusBar();

        this.addCommand({
            id: 'start-review',
            name: 'Start review',
            callback: () => new SessionConfigModal(this.app, this).open(),
        });

        this.addCommand({
            id: 'show-stats',
            name: 'Review stats',
            callback: () => new StatsModal(this.app, this).open(),
        });

        this.addSettingTab(new SymbolinkSettingTab(this.app, this));

        this.addRibbonIcon('layers', 'Symbolink: Start review', () => {
            new SessionConfigModal(this.app, this).open();
        });
    }

    async loadSettings() {
        const saved = await this.loadData();
        this.data = Object.assign({ reviews: {}, settings: {}, history: {} }, saved || {});
        
        if (Object.keys(this.data.history || {}).length === 0 && Object.keys(this.data.reviews || {}).length > 0) {
            this.data.history = {};
            for (const cardId in this.data.reviews) {
                const r = this.data.reviews[cardId];
                if (r.lastReview) {
                    if (!this.data.history[r.lastReview]) {
                        this.data.history[r.lastReview] = { correct: 0, incorrect: 0 };
                    }
                    if (r.correct > 0) this.data.history[r.lastReview].correct += 1;
                    else this.data.history[r.lastReview].incorrect += 1;
                }
            }
        }
        
        this.settings = Object.assign({}, DEFAULT_SETTINGS, this.data.settings);
    }

    async saveSettings() {
        this.data.settings = this.settings;
        await this.saveData(this.data);
        this.updateStatusBar();
    }

    updateStatusBar() {
        if (!this.statusBarItem) return;
        let due = 0;
        const nowStr = today();
        if (this.data && this.data.reviews) {
            for (const cardId in this.data.reviews) {
                const r = this.data.reviews[cardId];
                if (r.nextReview && r.nextReview <= nowStr) {
                    due++;
                }
            }
        }
        
        if (due > 0) {
            this.statusBarItem.setText(`💡 Fiszki: ${due} do powtórki`);
        } else {
            this.statusBarItem.setText(`💡 Fiszki: Zrobione!`);
        }
    }
}

module.exports = SymbolinkPlugin;