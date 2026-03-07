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
};

/* ───────────────────────────────────────────
   Helpers
   ─────────────────────────────────────────── */

function today() {
    return new Date().toISOString().slice(0, 10);
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
    if (fuzzy) {
        return normalize(given) === normalize(expected);
    }
    return given.trim() === expected.trim();
}

/* ───────────────────────────────────────────
   Card builder
   ─────────────────────────────────────────── */

function buildCards(app, settings) {
    const cards = [];
    const files = app.vault.getMarkdownFiles();

    for (const file of files) {
        if (settings.filterFolder && !file.path.startsWith(settings.filterFolder)) {
            continue;
        }

        const cache = app.metadataCache.getFileCache(file);
        if (!cache || !cache.frontmatter) continue;

        const fm = cache.frontmatter;
        const answer = file.basename;

        const fmTags = fm.tags || [];
        const tagList = Array.isArray(fmTags) ? fmTags : [fmTags];

        // Skip cards marked with _category (excluded from study)
        let hasCategory = tagList.some(t => String(t).replace(/^#/, '').startsWith('_category/'));
        if (!hasCategory && cache.tags) {
            hasCategory = cache.tags.some(t => t.tag.replace(/^#/, '').startsWith('_category/'));
        }
        if (hasCategory) continue;

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

        if (!hasHints && aliasList.filter(Boolean).length === 0) continue;

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
            });
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

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('symbolink-modal');

        contentEl.createEl('h2', { text: 'Session setup' });

        const s = this.plugin.settings;
        let count = s.cardsPerSession;
        let filterLang = s.filterLang || '';
        let filterField = s.filterField || '';
        let includeStandard = true;
        let includeImageOnly = s.imageOnlyCards;
        let includeAlias = true;

        // Cards count
        new obsidian.Setting(contentEl)
            .setName('Cards')
            .addText(text => text
                .setValue(String(count))
                .onChange(v => { const n = parseInt(v); if (!isNaN(n) && n > 0) count = n; }));

        // Language filter
        const makeBtnGroup = (setting, current, onChange) => {
            const row = setting.controlEl.createDiv({ cls: 'symbolink-cat-buttons' });
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

        const languages = collectLanguages(this.app, s);
        if (languages.length > 0) {
            const langSetting = new obsidian.Setting(contentEl).setName('Language');
            const makeBtn = makeBtnGroup(langSetting, filterLang, v => filterLang = v);
            makeBtn('All', '');
            for (const l of languages) makeBtn(l, l);
        }

        // Field filter
        const fields = collectFields(this.app, s);
        if (fields.length > 0) {
            const fieldSetting = new obsidian.Setting(contentEl).setName('Field');
            const makeBtn = makeBtnGroup(fieldSetting, filterField, v => filterField = v);
            makeBtn('All', '');
            for (const f of fields) makeBtn(f, f);
        }

        // Card types
        contentEl.createEl('div', { text: 'Card types', cls: 'symbolink-section-label' });

        new obsidian.Setting(contentEl)
            .setName('Standard (nodes / tags)')
            .addToggle(t => t.setValue(includeStandard).onChange(v => includeStandard = v));

        new obsidian.Setting(contentEl)
            .setName('Image only')
            .addToggle(t => t.setValue(includeImageOnly).onChange(v => includeImageOnly = v));

        new obsidian.Setting(contentEl)
            .setName('Alias')
            .addToggle(t => t.setValue(includeAlias).onChange(v => includeAlias = v));

        // Buttons
        const btnRow = contentEl.createDiv({ cls: 'symbolink-buttons' });
        btnRow.style.marginTop = '1rem';

        const startBtn = btnRow.createEl('button', { text: 'Start', cls: 'symbolink-btn symbolink-btn-check' });
        const cancelBtn = btnRow.createEl('button', { text: 'Cancel', cls: 'symbolink-btn symbolink-btn-skip' });

        startBtn.addEventListener('click', () => {
            this.close();
            new ReviewModal(this.app, this.plugin, {
                cardsPerSession: count,
                filterLang,
                filterField,
                includeStandard,
                includeImageOnly,
                includeAlias,
            }).open();
        });

        cancelBtn.addEventListener('click', () => this.close());
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

        const sc = this.sessionConfig;
        let allCards = buildCards(this.app, this.plugin.settings);
        if (sc) {
            allCards = allCards.filter(c => {
                if (c.type === 'standard' && !sc.includeStandard) return false;
                if (c.type === 'image_only' && !sc.includeImageOnly) return false;
                if (c.type === 'alias_to_name' && !sc.includeAlias) return false;
                if (sc.filterLang && !c.langTags.includes(sc.filterLang)) return false;
                if (sc.filterField && !c.fieldTags.includes(sc.filterField)) return false;
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

        if (card.type === 'alias_to_name') {
            hintArea.createEl('div', { text: card.aliasHint, cls: 'symbolink-alias-hint' });
            hintArea.createEl('div', { text: 'alias → filename', cls: 'symbolink-hint-label' });
        } else if (card.type === 'image_only') {
            try {
                const imgPath = card.image.replace(/^!?\[\[(.+)\]\]$/, '$1');
                const imgFile = this.app.metadataCache.getFirstLinkpathDest(imgPath, '');
                if (imgFile) {
                    const imgEl = hintArea.createEl('img', { cls: 'symbolink-image' });
                    imgEl.src = this.app.vault.getResourcePath(imgFile);
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
                    const imgPath = card.image.replace(/^!?\[\[(.+)\]\]$/, '$1');
                    const imgFile = this.app.metadataCache.getFirstLinkpathDest(imgPath, '');
                    if (imgFile) {
                        const imgEl = hintArea.createEl('img', { cls: 'symbolink-image' });
                        imgEl.src = this.app.vault.getResourcePath(imgFile);
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

        // Input
        const inputArea = contentEl.createDiv({ cls: 'symbolink-input-area' });
        const input = inputArea.createEl('input', {
            type: 'text',
            placeholder: 'Type your answer...',
            cls: 'symbolink-input',
        });

        // Feedback (hidden)
        const feedback = contentEl.createDiv({ cls: 'symbolink-feedback' });
        feedback.style.display = 'none';

        // Buttons
        const btnRow = contentEl.createDiv({ cls: 'symbolink-buttons' });
        const checkBtn = btnRow.createEl('button', { text: 'Check', cls: 'symbolink-btn symbolink-btn-check' });
        const skipBtn = btnRow.createEl('button', { text: 'Skip', cls: 'symbolink-btn symbolink-btn-skip' });
        const nextBtn = btnRow.createEl('button', { text: 'Next →', cls: 'symbolink-btn symbolink-btn-next' });
        nextBtn.style.display = 'none';
        const openBtn = btnRow.createEl('button', { text: 'Open in tab', cls: 'symbolink-btn symbolink-btn-open' });
        openBtn.style.display = 'none';

        const doCheck = () => {
            if (this.revealed) return;
            this.revealed = true;

            const given = input.value;
            const correct = checkAnswer(given, card.answer, this.plugin.settings.fuzzyMatch);

            feedback.style.display = 'block';
            feedback.empty();

            if (correct) {
                feedback.addClass('symbolink-correct');
                feedback.removeClass('symbolink-incorrect');
                feedback.createEl('div', { text: '✓ Correct!', cls: 'symbolink-fb-result' });
                this.sessionCorrect++;
                this.recordReview(card.id, true);
            } else {
                feedback.addClass('symbolink-incorrect');
                feedback.removeClass('symbolink-correct');
                feedback.createEl('div', { text: '✗ Wrong', cls: 'symbolink-fb-result' });
                feedback.createEl('div', { text: `Answer: ${card.answer}`, cls: 'symbolink-fb-answer' });
                if (given.trim() !== '') {
                    feedback.createEl('div', { text: `Your answer: ${given}`, cls: 'symbolink-fb-given' });
                }
                this.sessionIncorrect++;
                this.recordReview(card.id, false);
            }

            input.readOnly = true;
            checkBtn.style.display = 'none';
            skipBtn.style.display = 'none';
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
            const basePath = card.id.split('::')[0];
            const file = this.app.vault.getAbstractFileByPath(basePath);
            if (file) {
                this.app.workspace.getLeaf('tab').openFile(file);
            }
        });

        setTimeout(() => input.focus(), 50);
    }

    recordReview(cardId, correct) {
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
            data.box = Math.min(data.box + 1, BOX_INTERVALS.length - 1);
        } else {
            data.incorrect++;
            data.box = Math.max(data.box - 1, 0);
        }

        const interval = BOX_INTERVALS[data.box];
        const next = new Date();
        next.setDate(next.getDate() + interval);
        data.nextReview = next.toISOString().slice(0, 10);

        this.plugin.saveData(this.plugin.data);
    }

    showSummary() {
        const { contentEl } = this;
        contentEl.empty();

        const total = this.sessionCorrect + this.sessionIncorrect;
        const pct = total > 0 ? Math.round((this.sessionCorrect / total) * 100) : 0;

        const summary = contentEl.createDiv({ cls: 'symbolink-summary' });
        summary.createEl('h2', { text: 'Session complete' });
        summary.createEl('div', { text: `Correct: ${this.sessionCorrect}`, cls: 'symbolink-summary-correct' });
        summary.createEl('div', { text: `Wrong: ${this.sessionIncorrect}`, cls: 'symbolink-summary-incorrect' });
        summary.createEl('div', { text: `Accuracy: ${pct}%`, cls: 'symbolink-summary-pct' });

        const reviewCount = Object.keys(this.plugin.data.reviews).length;
        const allCards = buildCards(this.app, this.plugin.settings);
        summary.createEl('div', {
            text: `Total cards: ${allCards.length} · Ever reviewed: ${reviewCount}`,
            cls: 'symbolink-summary-total'
        });

        const btnRow = contentEl.createDiv({ cls: 'symbolink-buttons' });
        const againBtn = btnRow.createEl('button', { text: 'Again', cls: 'symbolink-btn symbolink-btn-check' });
        againBtn.addEventListener('click', () => {
            this.currentIndex = 0;
            this.sessionCorrect = 0;
            this.sessionIncorrect = 0;
            this.onOpen();
        });

        const closeBtn = btnRow.createEl('button', { text: 'Close', cls: 'symbolink-btn symbolink-btn-skip' });
        closeBtn.addEventListener('click', () => this.close());
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

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('symbolink-modal');

        const reviews = this.plugin.data.reviews;
        const allCards = buildCards(this.app, this.plugin.settings);
        const now = today();

        let dueCount = 0;
        let newCount = 0;
        let totalCorrect = 0;
        let totalIncorrect = 0;
        const boxCounts = new Array(BOX_INTERVALS.length).fill(0);

        for (const card of allCards) {
            const data = reviews[card.id];
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
            }
        }

        contentEl.createEl('h2', { text: 'Symbolink Stats' });

        const grid = contentEl.createDiv({ cls: 'symbolink-stats-grid' });

        const addStat = (label, value) => {
            const row = grid.createDiv({ cls: 'symbolink-stat-row' });
            row.createEl('span', { text: label, cls: 'symbolink-stat-label' });
            row.createEl('span', { text: String(value), cls: 'symbolink-stat-value' });
        };

        addStat('Total cards', allCards.length);
        addStat('New (never reviewed)', newCount);
        addStat('Due today', dueCount);
        addStat('Correct answers', totalCorrect);
        addStat('Wrong answers', totalIncorrect);
        addStat('Accuracy', totalCorrect + totalIncorrect > 0
            ? Math.round(totalCorrect / (totalCorrect + totalIncorrect) * 100) + '%'
            : 'no data');

        contentEl.createEl('h3', { text: 'Box distribution' });
        const boxDiv = contentEl.createDiv({ cls: 'symbolink-box-chart' });
        for (let i = 0; i < BOX_INTERVALS.length; i++) {
            const row = boxDiv.createDiv({ cls: 'symbolink-box-row' });
            row.createEl('span', {
                text: `Box ${i} (${BOX_INTERVALS[i]}d)`,
                cls: 'symbolink-box-label'
            });
            const bar = row.createDiv({ cls: 'symbolink-box-bar-bg' });
            const fill = bar.createDiv({ cls: 'symbolink-box-bar-fill' });
            const maxCount = Math.max(...boxCounts, 1);
            fill.style.width = (boxCounts[i] / maxCount * 100) + '%';
            row.createEl('span', { text: String(boxCounts[i]), cls: 'symbolink-box-count' });
        }

        contentEl.createEl('br');
        const resetBtn = contentEl.createEl('button', {
            text: 'Reset progress',
            cls: 'symbolink-btn symbolink-btn-skip'
        });
        resetBtn.addEventListener('click', () => {
            if (confirm('Are you sure you want to delete all review data?')) {
                this.plugin.data.reviews = {};
                this.plugin.saveData(this.plugin.data);
                new obsidian.Notice('Progress reset');
                this.onOpen();
            }
        });
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
        this.data = Object.assign({ reviews: {}, settings: {} }, saved || {});
        this.settings = Object.assign({}, DEFAULT_SETTINGS, this.data.settings);
    }

    async saveSettings() {
        this.data.settings = this.settings;
        await this.saveData(this.data);
    }
}

module.exports = SymbolinkPlugin;
