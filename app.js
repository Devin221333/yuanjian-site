(() => {
  // ===== 匿名访问统计（百度统计）=====
  // 在百度统计后台添加网站后，把“统计代码”里 hm.js? 后面那串 ID 填到下面引号里即可生效。
  // 留空时不加载任何统计脚本，网站照常运行。
  const ANALYTICS_BAIDU_ID = '';
  window._hmt = window._hmt || [];
  if (ANALYTICS_BAIDU_ID && !document.querySelector('script[data-analytics="baidu"]')) {
    const tag = document.createElement('script');
    tag.async = true;
    tag.dataset.analytics = 'baidu';
    tag.src = `https://hm.baidu.com/hm.js?${ANALYTICS_BAIDU_ID}`;
    document.head.appendChild(tag);
  }
  const track = (category, action, label) => {
    if (!ANALYTICS_BAIDU_ID) return;
    try { window._hmt.push(['_trackEvent', category, action, label || '']); } catch (_) { /* 统计失败不影响网站 */ }
  };
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href^="recommendation.html"]');
    if (link) track('入口', '点击开始测评', document.title);
  });

  const $ = (selector) => document.querySelector(selector);
  const format = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });

  const currentFile = location.pathname.split('/').pop() || 'index.html';
  const allocationFiles = new Set(['recommendation.html', 'profile.html', 'portfolio.html', 'review.html']);
  const mobileItems = [
    { href: 'index.html', key: 'index.html', icon: '市', label: '市场' },
    { href: 'assets.html', key: 'assets.html', icon: '资', label: '资产' },
    { href: 'analysis.html', key: 'analysis.html', icon: '史', label: '历史' },
    { href: 'recommendation.html', key: 'allocation', icon: '配', label: '配置' }
  ];
  const mobileNav = document.createElement('nav');
  mobileNav.className = 'mobile-bottom-nav';
  mobileNav.setAttribute('aria-label', '手机端主导航');
  mobileItems.forEach((item) => {
    const link = document.createElement('a');
    const icon = document.createElement('span');
    const label = document.createElement('small');
    const active = item.key === 'allocation' ? allocationFiles.has(currentFile) : currentFile === item.key;
    link.href = item.href;
    if (active) link.className = 'active';
    if (active) link.setAttribute('aria-current', 'page');
    icon.textContent = item.icon;
    label.textContent = item.label;
    link.append(icon, label);
    mobileNav.appendChild(link);
  });
  document.body.appendChild(mobileNav);

  const tabs = document.querySelectorAll('.tab');
  if (tabs.length) {
    const labels = {
      all: '显示全部资产',
      growth: '显示增长型资产',
      income: '显示收益型资产',
      liquidity: '显示流动性资产',
      hedge: '显示对冲型资产'
    };
    tabs.forEach((tab) => tab.addEventListener('click', () => {
      const type = tab.dataset.filter;
      tabs.forEach((item) => item.setAttribute('aria-pressed', String(item === tab)));
      document.querySelectorAll('[data-type]').forEach((card) => {
        card.hidden = type !== 'all' && card.dataset.type !== type;
      });
      const filterNote = $('#filter-note');
      if (filterNote) filterNote.textContent = labels[type];
    }));
  }

  const note = $('#investment-note');
  const save = $('#save-note');
  if (note && save) {
    note.value = localStorage.getItem('yuanjian-investment-note') || '';
    save.addEventListener('click', () => {
      localStorage.setItem('yuanjian-investment-note', note.value);
      $('#note-state').textContent = '已保存到这台设备';
    });
  }

  let marketDataCache;
  const getMarketData = () => {
    if (!marketDataCache) {
      marketDataCache = fetch('data/market-details.json', { cache: 'no-store' }).then((response) => {
        if (!response.ok) throw new Error('market database unavailable');
        return response.json();
      });
    }
    return marketDataCache;
  };

  const marketMap = (data) => new Map(data.markets.map((market) => [market.id, market]));

  async function loadLiveUsdCny() {
    try {
      const response = await fetch('https://api.frankfurter.dev/v2/rate/usd/cny');
      if (!response.ok) throw new Error('live FX unavailable');
      const payload = await response.json();
      return Number(payload.rate);
    } catch (_) {
      return null;
    }
  }

  async function loadMarketOverview() {
    const status = $('#market-status');
    if (!status) return;
    try {
      const data = await getMarketData();
      const records = marketMap(data);
      const aShare = records.get('a-share');
      const hongKong = records.get('hong-kong');
      const fx = records.get('fx');
      const globalRisk = records.get('global-risk');

      $('#a-share-value').textContent = aShare.headline.value;
      $('#a-share-note').textContent = `${aShare.headline.change} · ${aShare.headline.asOf}`;
      $('#hk-value').textContent = hongKong.headline.value;
      $('#hk-note').textContent = `${hongKong.headline.change} · ${hongKong.headline.asOf}`;
      $('#usd-cny').textContent = fx.headline.value;
      $('#usd-cny-note').textContent = `${fx.headline.change} · 中间价`;
      $('#global-value').textContent = globalRisk.headline.value;
      $('#global-note').textContent = `10 年期美债 · Brent ${globalRisk.metrics[1].value}`;
      status.textContent = `数据快照：${data.updatedAt}（${data.timezone}）`;
    } catch (_) {
      status.textContent = '市场数据暂时无法载入';
    }
  }
  loadMarketOverview();

  async function loadNews() {
    const listNode = $('#news-list');
    if (!listNode) return;
    try {
      const response = await fetch('data/news.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('news unavailable');
      const data = await response.json();
      const monthDay = (date) => {
        const [, month, day] = String(date).split('-');
        return `${Number(month)} 月 ${Number(day)} 日`;
      };
      // 新闻超过 3 天没更新（免费模式下不会自动更新）时，不再称为“今天”，并写明消息日期
      const beijingToday = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const ageDays = (Date.parse(beijingToday) - Date.parse(String(data.updatedAt).slice(0, 10))) / 86400000;
      const stale = Number.isFinite(ageDays) && ageDays > 3;
      const dates = data.items.map((item) => item.date).filter(Boolean).sort();
      const dateRange = dates.length && dates[0] !== dates[dates.length - 1]
        ? `${monthDay(dates[0])}—${monthDay(dates[dates.length - 1])}`
        : monthDay(dates[0] || data.updatedAt);
      $('#news-status').textContent = stale ? `消息日期：${dateRange}` : `${data.updatedAt} 更新`;
      const setText = (selector, text) => { const node = $(selector); if (node) node.textContent = text; };
      if (stale) {
        setText('#news-heading', '最近观察');
        setText('#news-eyebrow', '近期观察');
        setText('#news-fold-title', '近期市场观察');
      }
      const thesis = $('#current-regime');
      thesis.replaceChildren(makeElement('strong', '', stale ? '近期主线：' : '今日主线：'), document.createTextNode(data.thesis));
      const hint = $('#news-fold-hint');
      if (hint) hint.textContent = stale
        ? `${dateRange}的 ${data.items.length} 条消息，以及怎么判断它们和你有没有关系`
        : `${data.items.length} 条消息，以及怎么判断它们和你有没有关系`;
      listNode.replaceChildren();
      data.items.forEach((item) => {
        const article = makeElement('article', 'news-item');
        const meta = makeElement('div');
        const time = makeElement('time', '', monthDay(item.date));
        time.setAttribute('datetime', item.date);
        meta.append(makeElement('span', 'source-chip', `${item.category} · ${item.source}`), time);
        article.append(meta, makeElement('strong', '', item.title), makeElement('p', '', item.summary));
        if (/^https?:\/\//.test(item.url || '')) {
          const link = makeElement('a', '', '查看原文');
          link.href = item.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          article.appendChild(link);
        }
        listNode.appendChild(article);
      });
    } catch (_) {
      listNode.replaceChildren(makeElement('p', 'loading-copy', '消息暂时无法载入，请稍后刷新。'));
    }
  }

  async function renderHomeCompare() {
    const svg = $('#compare-chart');
    if (!svg) return;
    const ns = 'http://www.w3.org/2000/svg';
    const maxDrawdown = (series) => {
      let peak = series[0];
      let worst = 0;
      series.forEach((value) => {
        peak = Math.max(peak, value);
        worst = Math.min(worst, value / peak - 1);
      });
      return Math.round(Math.abs(worst) * 100);
    };
    try {
      const response = await fetch('data/historical-analysis.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('history unavailable');
      const data = await response.json();
      const timeline = data.profileTimeline;
      const assetsByDate = new Map(data.assetTimeline.map((row) => [row.date, row]));
      const base = assetsByDate.get(timeline[0].date)['a-share'];
      const single = timeline.map((row) => assetsByDate.get(row.date)['a-share'] / base * 100);
      const mixed = timeline.map((row) => row.balanced);

      const [year, month] = timeline[0].date.split('-');
      $('#compare-start').textContent = `${year} 年 ${Number(month)} 月`;
      $('#compare-single-end').textContent = `${Math.round(single[single.length - 1])} 元`;
      $('#compare-mixed-end').textContent = `${Math.round(mixed[mixed.length - 1])} 元`;
      $('#compare-single-dd').textContent = `${maxDrawdown(single)}%`;
      $('#compare-mixed-dd').textContent = `${maxDrawdown(mixed)}%`;

      const width = 520;
      const height = 220;
      const pad = { top: 12, right: 8, bottom: 26, left: 34 };
      const all = single.concat(mixed);
      const low = Math.floor(Math.min(...all) / 20) * 20;
      const high = Math.ceil(Math.max(...all) / 20) * 20;
      const x = (index) => pad.left + index / (timeline.length - 1) * (width - pad.left - pad.right);
      const y = (value) => pad.top + (high - value) / (high - low) * (height - pad.top - pad.bottom);
      const node = (tag, attrs) => {
        const element = document.createElementNS(ns, tag);
        Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, value));
        return element;
      };
      svg.replaceChildren();
      for (let tick = low; tick <= high; tick += 20) {
        svg.appendChild(node('line', { x1: pad.left, x2: width - pad.right, y1: y(tick), y2: y(tick), class: tick === 100 ? 'grid base' : 'grid' }));
        const label = node('text', { x: pad.left - 6, y: y(tick) + 4, 'text-anchor': 'end', class: 'axis' });
        label.textContent = tick;
        svg.appendChild(label);
      }
      const years = [...new Set(timeline.map((row) => row.date.slice(0, 4)))];
      years.filter((item, index) => index % 2 === 1).forEach((item) => {
        const index = timeline.findIndex((row) => row.date.startsWith(item));
        const label = node('text', { x: x(index), y: height - 6, 'text-anchor': 'middle', class: 'axis' });
        label.textContent = item;
        svg.appendChild(label);
      });
      const path = (series) => series.map((value, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join('');
      svg.appendChild(node('path', { d: path(single), class: 'line single' }));
      svg.appendChild(node('path', { d: path(mixed), class: 'line mixed' }));
    } catch (_) {
      svg.remove();
    }
  }
  renderHomeCompare();

  const makeElement = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  loadNews();

  async function renderMarketDetail() {
    const root = $('#market-detail-root');
    if (!root) return;
    const kickers = { 'a-share': '中国股票', 'hong-kong': '港股', fx: '人民币汇率', 'global-risk': '全球利率与能源' };
    try {
      const data = await getMarketData();
      const records = marketMap(data);
      const requestedId = new URLSearchParams(window.location.search).get('id') || 'a-share';
      const market = records.get(requestedId) || records.get('a-share');
      document.title = `${market.name}｜远见配置`;
      $('#detail-updated').textContent = `数据快照：${data.updatedAt}（${data.timezone}）${data.commentaryUpdatedAt ? ` · 解读更新于 ${data.commentaryUpdatedAt}` : ''}`;
      root.replaceChildren();

      const switcher = makeElement('nav', 'md-switcher');
      switcher.setAttribute('aria-label', '切换市场');
      data.markets.forEach((item) => {
        const link = makeElement('a', item.id === market.id ? 'active' : '', item.shortName);
        link.href = `market-detail.html?id=${item.id}`;
        if (item.id === market.id) link.setAttribute('aria-current', 'page');
        switcher.appendChild(link);
      });
      root.appendChild(switcher);

      const hero = makeElement('section', 'md-hero');
      const copy = makeElement('div', 'md-hero-copy');
      copy.append(makeElement('span', 'ad-kicker', kickers[market.id] || ''), makeElement('h1', '', market.name.replace('详情', '')), makeElement('p', 'ad-lead', market.summary));
      const headline = makeElement('aside', `md-headline ${market.headline.tone}`);
      headline.append(makeElement('span', '', market.headline.label), makeElement('strong', '', market.headline.value), makeElement('b', '', market.headline.change), makeElement('small', '', market.headline.asOf));
      hero.append(copy, headline);
      root.appendChild(hero);

      const section = (title, className) => {
        const node = makeElement('section', `ad-section ${className || ''}`);
        node.appendChild(makeElement('h2', '', title));
        root.appendChild(node);
        return node;
      };

      const metrics = section('关键数字', 'md-metrics-section');
      const grid = makeElement('div', 'md-metrics');
      market.metrics.forEach((metric) => {
        const card = makeElement('div', `md-metric ${metric.tone || 'flat'}`);
        card.append(makeElement('span', '', metric.label), makeElement('strong', '', metric.value), makeElement('b', '', metric.change), makeElement('small', '', metric.note));
        if (metric.dynamic) card.dataset.dynamic = metric.dynamic;
        grid.appendChild(card);
      });
      metrics.appendChild(grid);
      metrics.appendChild(makeElement('p', 'md-note', '红色代表上涨或人民币升值，绿色代表下跌；数据口径以来源页面为准。'));

      const signals = section('这些数字说明什么', 'md-signals-section');
      const signalRow = makeElement('div', 'md-signals');
      market.signals.forEach((signal) => {
        const card = makeElement('article', 'md-signal');
        card.append(makeElement('h3', '', signal.title), makeElement('p', '', signal.body));
        signalRow.appendChild(card);
      });
      signals.appendChild(signalRow);

      const decide = section('对你的组合意味着什么');
      const two = makeElement('div', 'ad-two');
      const impact = makeElement('div', 'ad-col md-impact');
      impact.append(makeElement('h3', '', '可以这样想'));
      const impactList = makeElement('ul');
      market.allocationImpact.forEach((item) => impactList.appendChild(makeElement('li', '', item)));
      impact.appendChild(impactList);
      const watch = makeElement('div', 'ad-col md-watch');
      watch.append(makeElement('h3', '', '接下来留意'));
      const watchList = makeElement('ul');
      market.watchNext.forEach((item) => watchList.appendChild(makeElement('li', '', item)));
      watch.appendChild(watchList);
      two.append(impact, watch);
      decide.appendChild(two);

      const related = makeElement('div', 'md-related');
      decide.appendChild(related);
      try {
        const [assetData, guideData] = await Promise.all([fetchAssetData(), fetchAssetGuides()]);
        const ids = guideData.guides.filter((guide) => guide.marketLink === market.id).map((guide) => guide.id);
        const linked = assetData.assets.filter((asset) => ids.includes(asset.id));
        if (linked.length) {
          related.appendChild(makeElement('span', '', '相关资产'));
          linked.forEach((asset) => {
            const link = makeElement('a', '', asset.name);
            link.href = `asset-detail.html?id=${asset.id}`;
            related.appendChild(link);
          });
        } else {
          related.remove();
        }
      } catch (_) {
        related.remove();
      }

      const sources = makeElement('details', 'sources-fold md-sources');
      const summary = makeElement('summary');
      summary.append(makeElement('strong', '', '数据从哪里来'), makeElement('span', '', `${market.sources.length} 个来源`));
      sources.append(summary, makeElement('p', '', data.disclaimer));
      const sourceList = makeElement('div', 'source-list');
      market.sources.forEach((source) => {
        const link = makeElement('a', '', `${source.name}（${source.type}）`);
        link.href = source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        sourceList.appendChild(link);
      });
      sources.appendChild(sourceList);
      root.appendChild(sources);

      const liveCard = document.querySelector('[data-dynamic="usd-cny-live"]');
      if (liveCard) {
        const liveRate = await loadLiveUsdCny();
        if (liveRate) {
          liveCard.querySelector('strong').textContent = liveRate.toLocaleString('zh-CN', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
          liveCard.querySelector('b').textContent = '公开参考汇率';
        } else {
          liveCard.remove();
        }
      }
    } catch (_) {
      root.replaceChildren();
      const error = makeElement('div', 'detail-loading');
      error.append(makeElement('strong', '', '市场详情暂时无法载入'), makeElement('span', '', '请稍后刷新，交易前以交易所、银行或券商显示的数据为准。'));
      root.appendChild(error);
    }
  }
  renderMarketDetail();

  const fetchAssetData = () => fetch('data/assets.json', { cache: 'no-store' }).then((response) => {
    if (!response.ok) throw new Error('asset database unavailable');
    return response.json();
  });
  const fetchChannelData = () => fetch('data/channels.json', { cache: 'no-store' }).then((response) => {
    if (!response.ok) throw new Error('channel database unavailable');
    return response.json();
  });
  const fetchAssetGuides = () => fetch('data/asset-guides.json', { cache: 'no-store' }).then((response) => {
    if (!response.ok) throw new Error('asset guide unavailable');
    return response.json();
  });

  async function renderAssetDetail() {
    const root = $('#asset-detail-root');
    if (!root) return;
    const riskLevels = { '低': 1, '低至中': 2, '中': 3, '中至高': 4, '高': 5 };
    const riskWords = ['', '很低', '较低', '中等', '较高', '高'];
    const historyLink = { 'a-share-broad': 'a-share', 'hk-broad': 'hong-kong', 'book-entry-treasury': 'rmb-bond', 'us-equity': 'global-equity', gold: 'gold', 'global-reits': 'reits' };
    const list = (items, className) => {
      const ul = makeElement('ul', className || '');
      items.forEach((item) => ul.appendChild(makeElement('li', '', item)));
      return ul;
    };
    try {
      const [assetData, channelData, guideData] = await Promise.all([fetchAssetData(), fetchChannelData(), fetchAssetGuides()]);
      const requestedId = new URLSearchParams(window.location.search).get('id') || assetData.assets[0].id;
      const assetIndex = Math.max(0, assetData.assets.findIndex((item) => item.id === requestedId));
      const asset = assetData.assets[assetIndex];
      const guide = guideData.guides.find((item) => item.id === asset.id);
      if (!guide) throw new Error('asset guide missing');
      const channelMap = new Map(channelData.channels.map((item) => [item.id, item]));
      const level = riskLevels[asset.risk] || 3;
      document.title = `${asset.name}｜远见配置`;
      track('资产档案', '查看', asset.name);
      $('#asset-detail-updated').textContent = `资料日期：${assetData.updatedAt}`;
      root.replaceChildren();

      // Hero
      const hero = makeElement('section', 'ad-hero');
      hero.append(makeElement('span', 'ad-kicker', `${asset.market} · ${asset.category}`), makeElement('h1', '', asset.name), makeElement('p', 'ad-lead', asset.description));
      root.appendChild(hero);

      const layout = makeElement('div', 'ad-layout');
      const main = makeElement('div', 'ad-main');

      // Summary card (sticky right on desktop, top on mobile)
      const card = makeElement('aside', 'ad-summary');
      const roleLine = makeElement('div', 'ad-role');
      roleLine.append(makeElement('span', '', '在组合里负责'), makeElement('strong', '', asset.role));
      const meter = makeElement('div', 'ad-meter');
      const meterBar = makeElement('div', 'ad-meter-bar');
      for (let index = 1; index <= 5; index += 1) meterBar.appendChild(makeElement('i', index <= level ? 'on' : ''));
      meter.append(makeElement('span', '', '风险'), meterBar, makeElement('b', '', riskWords[level]));
      const facts = makeElement('div', 'ad-facts');
      [['取钱方便吗', asset.liquidity], ['币种', asset.currency], ['难度', asset.beginner]].forEach(([label, value]) => {
        const fact = makeElement('div');
        fact.append(makeElement('span', '', label), makeElement('strong', '', value));
        facts.appendChild(fact);
      });
      card.append(roleLine, meter, facts);
      const historyBox = makeElement('div', 'ad-history');
      historyBox.hidden = true;
      card.appendChild(historyBox);
      if (guide.marketLink) {
        const marketLink = makeElement('a', 'ad-market-link', '看今天相关市场数据');
        marketLink.href = `market-detail.html?id=${guide.marketLink}`;
        card.appendChild(marketLink);
      }
      const ctaLink = makeElement('a', 'primary-button ad-cta', '测一测它该占多少');
      ctaLink.href = 'recommendation.html';
      card.appendChild(ctaLink);

      // 1. Fit
      const fit = makeElement('section', 'ad-section');
      fit.appendChild(makeElement('h2', '', '适合你吗？'));
      const fitGrid = makeElement('div', 'ad-two');
      const yes = makeElement('div', 'ad-col yes');
      yes.append(makeElement('h3', '', '适合用来'), list(guide.fit));
      const no = makeElement('div', 'ad-col no');
      no.append(makeElement('h3', '', '别这样用'), list(guide.avoid));
      fitGrid.append(yes, no);
      fit.appendChild(fitGrid);
      main.appendChild(fit);

      // 2. Drivers vs risks (side by side on desktop, tabs on mobile)
      const mechanics = makeElement('section', 'ad-section');
      mechanics.appendChild(makeElement('h2', '', '它靠什么赚钱，又会怎么亏？'));
      const tabs = makeElement('div', 'ad-tabs');
      tabs.setAttribute('role', 'tablist');
      const pane = makeElement('div', 'ad-two ad-tabbed');
      pane.dataset.tab = 'gain';
      [['gain', '靠什么赚钱'], ['loss', '可能怎么亏']].forEach(([id, label]) => {
        const button = makeElement('button', id === 'gain' ? 'active' : '', label);
        button.type = 'button';
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(id === 'gain'));
        button.addEventListener('click', () => {
          pane.dataset.tab = id;
          tabs.querySelectorAll('button').forEach((item) => {
            const on = item === button;
            item.classList.toggle('active', on);
            item.setAttribute('aria-selected', String(on));
          });
        });
        tabs.appendChild(button);
      });
      const gain = makeElement('div', 'ad-col gain');
      gain.append(makeElement('h3', '', '靠什么赚钱'), list(guide.drivers));
      const loss = makeElement('div', 'ad-col loss');
      loss.append(makeElement('h3', '', '可能怎么亏'), list(guide.risks));
      pane.append(gain, loss);
      mechanics.append(tabs, pane);
      main.appendChild(mechanics);

      // 3. How to buy
      const buy = makeElement('section', 'ad-section');
      buy.appendChild(makeElement('h2', '', '在国内怎么买？'));
      const tools = makeElement('div', 'ad-tools');
      tools.appendChild(makeElement('span', '', '常见工具'));
      asset.vehicles.forEach((item) => tools.appendChild(makeElement('b', '', item)));
      buy.appendChild(tools);
      const channels = makeElement('div', 'ad-channels');
      asset.channelIds.forEach((id) => {
        const channel = channelMap.get(id);
        if (!channel) return;
        const item = makeElement('details', 'ad-channel');
        const summary = makeElement('summary');
        const text = makeElement('span');
        text.append(makeElement('strong', '', channel.name), makeElement('small', '', channel.threshold));
        const tone = channel.level.includes('门槛') ? 'warn' : channel.level.includes('进阶') ? 'adv' : '';
        summary.append(text, makeElement('span', `level-badge ${tone}`, channel.level));
        const body = makeElement('dl');
        [['需要什么账户', channel.account], ['费用看哪里', channel.costFocus], ['要注意', channel.risks.join('；')]].forEach(([label, value]) => {
          const row = makeElement('div');
          row.append(makeElement('dt', '', label), makeElement('dd', '', value));
          body.appendChild(row);
        });
        item.append(summary, body);
        channels.appendChild(item);
      });
      buy.appendChild(channels);
      main.appendChild(buy);

      // 4. Checklist (tickable)
      const check = makeElement('section', 'ad-section');
      check.appendChild(makeElement('h2', '', '买之前，逐条确认'));
      const progress = makeElement('p', 'ad-check-progress');
      check.appendChild(progress);
      const checklist = makeElement('div', 'ad-checklist');
      const items = [...guide.questions.map((text) => ({ text, tag: '问自己' })), ...asset.checks.map((text) => ({ text, tag: '查产品' }))];
      const updateProgress = () => {
        const done = checklist.querySelectorAll('input:checked').length;
        progress.textContent = done === items.length ? '全部确认完了，可以去比较具体产品。' : `已确认 ${done} / ${items.length} 项`;
      };
      items.forEach((item) => {
        const label = makeElement('label', 'ad-check');
        const input = makeElement('input');
        input.type = 'checkbox';
        input.addEventListener('change', updateProgress);
        const copy = makeElement('span');
        copy.append(makeElement('em', item.tag === '问自己' ? 'self' : 'product', item.tag), document.createTextNode(item.text));
        label.append(input, copy);
        checklist.appendChild(label);
      });
      check.appendChild(checklist);
      updateProgress();
      main.appendChild(check);

      layout.append(main, card);
      root.appendChild(layout);

      // Prev / next
      const nav = makeElement('nav', 'ad-nav');
      nav.setAttribute('aria-label', '浏览其他资产');
      const previous = assetData.assets[(assetIndex - 1 + assetData.assets.length) % assetData.assets.length];
      const next = assetData.assets[(assetIndex + 1) % assetData.assets.length];
      const previousLink = makeElement('a', 'prev');
      previousLink.href = `asset-detail.html?id=${previous.id}`;
      previousLink.append(makeElement('span', '', '上一个'), makeElement('strong', '', previous.name));
      const nextLink = makeElement('a', 'next');
      nextLink.href = `asset-detail.html?id=${next.id}`;
      nextLink.append(makeElement('span', '', '下一个'), makeElement('strong', '', next.name));
      nav.append(previousLink, nextLink);
      root.appendChild(nav);

      // Optional: real history for the linked representative fund
      const historyId = historyLink[asset.id];
      if (historyId) {
        try {
          const response = await fetch('data/historical-analysis.json', { cache: 'no-store' });
          if (!response.ok) throw new Error('history unavailable');
          const data = await response.json();
          const record = data.assets.find((item) => item.id === historyId);
          const values = data.assetTimeline.map((row) => row[historyId]).filter(Number.isFinite);
          if (!record || values.length < 2) throw new Error('no series');
          const width = 260;
          const height = 64;
          const low = Math.min(...values);
          const high = Math.max(...values);
          const points = values.map((value, index) => `${(index / (values.length - 1) * width).toFixed(1)},${(height - 4 - (value - low) / (high - low || 1) * (height - 8)).toFixed(1)}`).join(' ');
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
          svg.setAttribute('aria-hidden', 'true');
          svg.setAttribute('preserveAspectRatio', 'none');
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
          line.setAttribute('points', points);
          line.setAttribute('vector-effect', 'non-scaling-stroke');
          svg.appendChild(line);
          const stats = makeElement('div', 'ad-history-stats');
          const annual = makeElement('div');
          annual.append(makeElement('span', '', '历史年化'), makeElement('strong', 'gain', `${record.metrics.annualizedReturn > 0 ? '+' : ''}${record.metrics.annualizedReturn}%`));
          const drawdown = makeElement('div');
          drawdown.append(makeElement('span', '', '最深跌过'), makeElement('strong', 'loss', `${record.metrics.maxDrawdown}%`));
          stats.append(annual, drawdown);
          historyBox.append(makeElement('span', 'ad-history-title', `过去 ${Math.round(record.metrics.years)} 年 · ${record.instrument}`), svg, stats);
          historyBox.hidden = false;
        } catch (_) {
          historyBox.remove();
        }
      } else {
        historyBox.remove();
      }
    } catch (_) {
      root.replaceChildren();
      const error = makeElement('div', 'detail-loading');
      error.append(makeElement('strong', '', '资产档案暂时无法载入'), makeElement('span', '', '请返回资产地图重试。'));
      root.appendChild(error);
    }
  }
  renderAssetDetail();

  async function loadAssetLibrary() {
    const matrix = $('#asset-matrix');
    if (!matrix) return;
    const list = $('#asset-list');
    const panel = $('#asset-panel');
    const backdrop = $('#sheet-backdrop');
    const chipsBox = $('#group-chips');
    const search = $('#database-search');
    const beginnerOnly = $('#beginner-only');
    const count = $('#database-count');
    const empty = $('#database-empty');
    const desktop = window.matchMedia('(min-width: 901px)');

    const groups = [
      { id: 'base', name: '人民币底仓', color: '#176a8d' },
      { id: 'china', name: '中国股票', color: '#75879b' },
      { id: 'overseas', name: '海外资产', color: '#6c5c9a' },
      { id: 'real', name: '实物与商品', color: '#b88732' }
    ];
    const riskLevels = { '低': 1, '低至中': 2, '中': 3, '中至高': 4, '高': 5 };
    const riskNames = ['', '低', '较低', '中', '较高', '高'];
    const groupOf = (asset) => {
      if (asset.category === '现金' || (asset.category === '固收' && asset.market === '中国内地')) return 'base';
      if (asset.category === '权益' && (asset.market === '中国内地' || asset.market === '中国香港')) return 'china';
      if (asset.category === '实物资产' || asset.category === '商品') return 'real';
      return 'overseas';
    };
    const dots = (level) => {
      const wrap = makeElement('span', 'risk-dots');
      wrap.setAttribute('aria-label', `风险 ${riskNames[level]}`);
      for (let index = 1; index <= 5; index += 1) wrap.appendChild(makeElement('i', index <= level ? 'on' : ''));
      return wrap;
    };

    try {
      const [assetData, channelData] = await Promise.all([fetchAssetData(), fetchChannelData()]);
      const channelMap = new Map(channelData.channels.map((item) => [item.id, item]));
      const assets = assetData.assets.map((asset) => ({ ...asset, group: groupOf(asset), level: riskLevels[asset.risk] || 3 }));
      $('#database-date').textContent = `资料日期：${assetData.updatedAt}`;

      const sources = $('#official-sources');
      sources.replaceChildren();
      channelData.sources.forEach((source) => {
        const link = makeElement('a', '', source.name);
        link.href = source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        sources.appendChild(link);
      });

      let activeGroup = 'all';
      let selectedId = null;

      const closeSheet = () => {
        panel.classList.remove('open');
        backdrop.hidden = true;
        document.body.classList.remove('sheet-open');
      };
      backdrop.addEventListener('click', closeSheet);
      let dragStart = null;
      panel.addEventListener('touchstart', (event) => {
        dragStart = panel.scrollTop <= 0 ? event.touches[0].clientY : null;
      }, { passive: true });
      panel.addEventListener('touchmove', (event) => {
        if (dragStart === null) return;
        const distance = event.touches[0].clientY - dragStart;
        if (distance > 0) panel.style.transform = `translateY(${distance}px)`;
      }, { passive: true });
      panel.addEventListener('touchend', (event) => {
        if (dragStart === null) return;
        const distance = event.changedTouches[0].clientY - dragStart;
        panel.style.transform = '';
        dragStart = null;
        if (distance > 90) closeSheet();
      });
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeSheet(); });

      const showAsset = (id, openSheet) => {
        const asset = assets.find((item) => item.id === id);
        if (!asset) return;
        if (openSheet) track('资产地图', '点开资产', asset.name);
        selectedId = id;
        document.querySelectorAll('[data-asset]').forEach((node) => node.classList.toggle('selected', node.dataset.asset === id));
        const group = groups.find((item) => item.id === asset.group);
        panel.style.setProperty('--group-color', group.color);
        panel.replaceChildren();

        const top = makeElement('div', 'panel-top');
        top.append(makeElement('span', 'panel-group', group.name));
        const close = makeElement('button', 'panel-close', '关闭');
        close.type = 'button';
        close.addEventListener('click', closeSheet);
        top.appendChild(close);
        panel.appendChild(makeElement('span', 'sheet-handle'));
        panel.append(top, makeElement('h3', '', asset.name), makeElement('p', 'panel-desc', asset.description));

        const stats = makeElement('div', 'panel-stats');
        const riskStat = makeElement('div');
        riskStat.append(makeElement('span', '', '风险'), dots(asset.level), makeElement('strong', '', asset.risk));
        const liquidity = makeElement('div');
        liquidity.append(makeElement('span', '', '流动性'), makeElement('strong', '', asset.liquidity));
        const currency = makeElement('div');
        currency.append(makeElement('span', '', '币种'), makeElement('strong', '', asset.currency));
        stats.append(riskStat, liquidity, currency);
        panel.appendChild(stats);

        const block = (title, items, className) => {
          const section = makeElement('div', 'panel-block');
          section.appendChild(makeElement('h4', '', title));
          const ul = makeElement('ul', className || '');
          items.forEach((item) => ul.appendChild(typeof item === 'string' ? makeElement('li', '', item) : item));
          section.appendChild(ul);
          panel.appendChild(section);
        };
        block('用什么工具买', asset.vehicles, 'chip-list');
        block('在哪里买', asset.channelIds.map((channelId) => {
          const channel = channelMap.get(channelId);
          const li = makeElement('li', 'channel-line');
          if (!channel) return li;
          const tone = channel.level.includes('门槛') ? 'warn' : channel.level.includes('进阶') ? 'adv' : '';
          li.append(makeElement('strong', '', channel.name), makeElement('span', `level-badge ${tone}`, channel.level), makeElement('small', '', channel.threshold));
          return li;
        }), 'channel-lines');
        block('买之前查清楚', asset.checks, 'check-list');

        const more = makeElement('a', 'primary-button panel-more', '查看完整档案');
        more.href = `asset-detail.html?id=${asset.id}`;
        panel.appendChild(more);

        if (openSheet && !desktop.matches) {
          panel.classList.add('open');
          backdrop.hidden = false;
          document.body.classList.add('sheet-open');
          panel.focus({ preventScroll: true });
        }
      };

      const matches = (asset) => {
        if (beginnerOnly.checked && asset.beginner !== '入门') return false;
        const term = search.value.trim().toLowerCase();
        if (!term) return true;
        return [asset.name, asset.description, asset.market, asset.category, asset.role, asset.currency, ...asset.vehicles]
          .join(' ').toLowerCase().includes(term);
      };

      const assetButton = (asset, className) => {
        const button = makeElement('button', className);
        button.type = 'button';
        button.dataset.asset = asset.id;
        button.style.setProperty('--group-color', groups.find((item) => item.id === asset.group).color);
        button.addEventListener('click', () => showAsset(asset.id, true));
        return button;
      };

      // Desktop: group x risk map
      matrix.replaceChildren();
      matrix.appendChild(makeElement('span', 'matrix-corner', ''));
      const riskHead = makeElement('div', 'matrix-risk-head');
      riskHead.append(makeElement('span', '', '风险低'), makeElement('i'), makeElement('span', '', '风险高'));
      matrix.appendChild(riskHead);
      groups.forEach((group) => {
        const label = makeElement('div', 'matrix-label');
        label.style.setProperty('--group-color', group.color);
        label.appendChild(makeElement('strong', '', group.name));
        matrix.appendChild(label);
        for (let level = 1; level <= 5; level += 1) {
          const cell = makeElement('div', 'matrix-cell');
          assets.filter((asset) => asset.group === group.id && asset.level === level).forEach((asset) => {
            const chip = assetButton(asset, 'matrix-chip');
            chip.appendChild(makeElement('span', '', asset.name));
            if (asset.beginner === '进阶') chip.appendChild(makeElement('small', '', '进阶'));
            cell.appendChild(chip);
          });
          matrix.appendChild(cell);
        }
      });

      // Mobile: group chips + rows
      chipsBox.replaceChildren();
      [{ id: 'all', name: '全部' }, ...groups].forEach((group) => {
        const chip = makeElement('button', group.id === 'all' ? 'group-chip active' : 'group-chip', group.name);
        chip.type = 'button';
        chip.dataset.group = group.id;
        chip.addEventListener('click', () => {
          activeGroup = group.id;
          chipsBox.querySelectorAll('.group-chip').forEach((item) => item.classList.toggle('active', item === chip));
          render();
        });
        chipsBox.appendChild(chip);
      });
      list.replaceChildren();
      groups.forEach((group) => {
        const section = makeElement('section', 'list-group');
        section.dataset.group = group.id;
        section.style.setProperty('--group-color', group.color);
        section.appendChild(makeElement('h3', '', group.name));
        assets.filter((asset) => asset.group === group.id).sort((a, b) => a.level - b.level).forEach((asset) => {
          const row = assetButton(asset, 'asset-row');
          const text = makeElement('span', 'asset-row-text');
          text.append(makeElement('strong', '', asset.name), makeElement('small', '', asset.role));
          row.append(text, dots(asset.level));
          row.appendChild(makeElement('em', asset.beginner === '入门' ? '' : 'adv', asset.beginner));
          section.appendChild(row);
        });
        list.appendChild(section);
      });

      const render = () => {
        let shown = 0;
        document.querySelectorAll('.matrix-chip').forEach((chip) => {
          const ok = matches(assets.find((item) => item.id === chip.dataset.asset));
          chip.classList.toggle('dim', !ok);
          if (ok) shown += 1;
        });
        list.querySelectorAll('.list-group').forEach((section) => {
          let visible = 0;
          section.querySelectorAll('.asset-row').forEach((row) => {
            const ok = matches(assets.find((item) => item.id === row.dataset.asset));
            row.hidden = !ok;
            if (ok) visible += 1;
          });
          section.hidden = !visible || (activeGroup !== 'all' && section.dataset.group !== activeGroup);
        });
        count.textContent = `${shown} / ${assets.length} 类`;
        empty.hidden = shown > 0;
      };

      search.addEventListener('input', render);
      beginnerOnly.addEventListener('change', render);
      desktop.addEventListener('change', () => { if (desktop.matches) closeSheet(); });
      render();
      if (desktop.matches) showAsset(selectedId || assets[0].id, false);
    } catch (_) {
      matrix.innerHTML = '<p class="database-loading">资料库暂时无法载入，请稍后刷新。</p>';
      count.textContent = '载入失败';
    }
  }
  loadAssetLibrary();

  const historyRoot = $('#history-lab');
  if (historyRoot) {
    const svgNs = 'http://www.w3.org/2000/svg';
    const bucketLabels = { bonds: '人民币债券', china: '中国股票', global: '海外股票', reits: '海外 REITs', gold: '黄金' };
    const seriesColors = {
      'a-share': '#a24743', 'hong-kong': '#d0826f', 'rmb-bond': '#75879b', 'global-equity': '#6c5c9a', gold: '#b88732', reits: '#4d8f88',
      conservative: '#8fb3c2', steady: '#4f93ad', balanced: '#176a8d', growth: '#1f4e6c', aggressive: '#0f2a40'
    };
    const assetNames = { 'a-share': '沪深 300', 'hong-kong': '恒生指数', 'rmb-bond': '国债', 'global-equity': '标普 500', gold: '黄金', reits: '美国 REITs' };
    const signed = (value, digits = 1) => `${value > 0 ? '+' : ''}${Number(value).toFixed(digits)}%`;
    const svgNode = (tag, attributes = {}) => {
      const node = document.createElementNS(svgNs, tag);
      Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
      return node;
    };

    function buildSeries(data) {
      const timeline = data.profileTimeline;
      const byDate = new Map(data.assetTimeline.map((row) => [row.date, row]));
      const first = byDate.get(timeline[0].date);
      const series = data.assets.map((asset) => ({
        id: asset.id, kind: 'asset', name: assetNames[asset.id] || asset.instrument, detail: asset.instrument,
        values: timeline.map((row) => byDate.get(row.date)[asset.id] / first[asset.id] * 100)
      }));
      data.profileBacktests.forEach((profile) => series.push({
        id: profile.id, kind: 'profile', name: `${profile.name}组合`, detail: '按推荐比例回测',
        values: timeline.map((row) => row[profile.id])
      }));
      return { dates: timeline.map((row) => row.date), series };
    }

    function initChart(data) {
      const { dates, series } = buildSeries(data);
      const picker = $('#series-picker');
      const svg = $('#history-line-chart');
      const box = $('#history-chart-box');
      const tooltip = $('#chart-tooltip');
      const summary = $('#series-summary');
      let selected = ['a-share', 'global-equity', 'balanced'];
      let geometry = null;

      picker.replaceChildren();
      [['asset', '单一资产'], ['profile', '组合']].forEach(([kind, label]) => {
        const group = makeElement('div', 'picker-group');
        group.appendChild(makeElement('span', 'picker-label', label));
        series.filter((item) => item.kind === kind).forEach((item) => {
          const chip = makeElement('button', 'series-chip');
          chip.type = 'button';
          chip.dataset.id = item.id;
          chip.style.setProperty('--series-color', seriesColors[item.id]);
          chip.append(makeElement('i'), document.createTextNode(item.name));
          chip.addEventListener('click', () => {
            if (selected.includes(item.id)) {
              if (selected.length > 1) selected = selected.filter((id) => id !== item.id);
            } else {
              selected = [...selected, item.id].slice(-4);
              track('历史验证', '加入对比', item.name);
            }
            draw();
          });
          group.appendChild(chip);
        });
        picker.appendChild(group);
      });

      function draw() {
        picker.querySelectorAll('.series-chip').forEach((chip) => {
          const on = selected.includes(chip.dataset.id);
          chip.classList.toggle('on', on);
          chip.setAttribute('aria-pressed', String(on));
        });
        const active = series.filter((item) => selected.includes(item.id));
        const width = Math.max(300, Math.round(box.clientWidth));
        const compact = width < 600;
        const height = compact ? 250 : 340;
        const pad = { top: 14, right: compact ? 10 : 18, bottom: 28, left: compact ? 34 : 44 };
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.replaceChildren();
        const all = active.flatMap((item) => item.values);
        const low = Math.floor(Math.min(...all, 100) / 20) * 20;
        const high = Math.ceil(Math.max(...all, 100) / 20) * 20;
        const x = (index) => pad.left + index / (dates.length - 1) * (width - pad.left - pad.right);
        const y = (value) => pad.top + (high - value) / (high - low) * (height - pad.top - pad.bottom);
        const step = (high - low) / 20 > 6 ? 40 : 20;
        for (let tick = low; tick <= high; tick += step) {
          svg.appendChild(svgNode('line', { x1: pad.left, x2: width - pad.right, y1: y(tick), y2: y(tick), class: tick === 100 ? 'hc-grid base' : 'hc-grid' }));
          const label = svgNode('text', { x: pad.left - 6, y: y(tick) + 4, 'text-anchor': 'end', class: 'hc-axis' });
          label.textContent = tick;
          svg.appendChild(label);
        }
        const years = [...new Set(dates.map((date) => date.slice(0, 4)))];
        let lastLabelX = -Infinity;
        years.forEach((year) => {
          const at = dates.findIndex((date) => date.startsWith(year));
          if (x(at) - lastLabelX < (compact ? 46 : 60) || x(at) - pad.left < 14) return;
          lastLabelX = x(at);
          const label = svgNode('text', { x: x(at), y: height - 8, 'text-anchor': 'middle', class: 'hc-axis' });
          label.textContent = compact ? `'${year.slice(2)}` : year;
          svg.appendChild(label);
        });
        active.forEach((item) => {
          const d = item.values.map((value, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join('');
          svg.appendChild(svgNode('path', { d, class: `hc-line ${item.kind}`, stroke: seriesColors[item.id] }));
        });
        const cursor = svgNode('line', { y1: pad.top, y2: height - pad.bottom, class: 'hc-cursor', visibility: 'hidden' });
        svg.appendChild(cursor);
        const markers = active.map((item) => {
          const dot = svgNode('circle', { r: 4.5, fill: seriesColors[item.id], class: 'hc-dot', visibility: 'hidden' });
          svg.appendChild(dot);
          return dot;
        });
        geometry = { x, y, pad, width, active, cursor, markers };

        summary.replaceChildren();
        active.forEach((item) => {
          const card = makeElement('div', 'summary-card');
          card.style.setProperty('--series-color', seriesColors[item.id]);
          const end = item.values[item.values.length - 1];
          card.append(makeElement('span', '', item.name), makeElement('strong', '', `${Math.round(end)} 元`), makeElement('small', '', `${item.detail} · 累计 ${signed(end - 100, 0)}`));
          summary.appendChild(card);
        });
        hideTip();
      }

      function hideTip() {
        tooltip.hidden = true;
        if (!geometry) return;
        geometry.cursor.setAttribute('visibility', 'hidden');
        geometry.markers.forEach((dot) => dot.setAttribute('visibility', 'hidden'));
      }

      function showTip(clientX) {
        if (!geometry) return;
        const rect = svg.getBoundingClientRect();
        const scale = geometry.width / rect.width;
        const px = (clientX - rect.left) * scale;
        const span = geometry.width - geometry.pad.left - (geometry.width - geometry.x(dates.length - 1));
        const index = Math.max(0, Math.min(dates.length - 1, Math.round((px - geometry.pad.left) / span * (dates.length - 1))));
        const cx = geometry.x(index);
        geometry.cursor.setAttribute('x1', cx);
        geometry.cursor.setAttribute('x2', cx);
        geometry.cursor.setAttribute('visibility', 'visible');
        tooltip.replaceChildren(makeElement('b', '', dates[index].slice(0, 7)));
        geometry.active.forEach((item, position) => {
          const value = item.values[index];
          geometry.markers[position].setAttribute('cx', cx);
          geometry.markers[position].setAttribute('cy', geometry.y(value));
          geometry.markers[position].setAttribute('visibility', 'visible');
          const line = makeElement('span');
          const dot = makeElement('i');
          dot.style.background = seriesColors[item.id];
          line.append(dot, document.createTextNode(`${item.name} ${value.toFixed(0)} 元`));
          tooltip.appendChild(line);
        });
        tooltip.hidden = false;
        const left = cx / scale;
        const tipWidth = tooltip.offsetWidth;
        tooltip.style.left = `${Math.min(Math.max(0, left - tipWidth / 2), rect.width - tipWidth)}px`;
      }

      svg.addEventListener('pointermove', (event) => showTip(event.clientX));
      svg.addEventListener('pointerdown', (event) => showTip(event.clientX));
      svg.addEventListener('pointerleave', (event) => { if (event.pointerType === 'mouse') hideTip(); });
      document.addEventListener('pointerdown', (event) => { if (!box.contains(event.target)) hideTip(); });
      let resizeTimer;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { if (document.body.contains(svg)) draw(); }, 150);
      });
      draw();
    }

    function tradeoffRows(container, rows) {
      const maxLoss = Math.max(...rows.map((row) => Math.abs(row.drawdown)));
      const maxGain = Math.max(...rows.map((row) => Math.max(0, row.annual)));
      container.replaceChildren();
      const head = makeElement('div', 'tradeoff-head');
      head.append(makeElement('span', '', ''), makeElement('span', 'loss', '途中最深跌'), makeElement('span', 'gain', '平均每年'));
      container.appendChild(head);
      rows.forEach((row) => {
        const item = makeElement('div', 'tradeoff-row');
        item.style.setProperty('--row-color', row.color);
        const label = makeElement('div', 'tradeoff-label');
        label.append(makeElement('strong', '', row.name), makeElement('small', '', row.sub));
        const loss = makeElement('div', 'tradeoff-bar loss');
        const lossFill = makeElement('i');
        lossFill.style.width = `${Math.abs(row.drawdown) / maxLoss * 100}%`;
        loss.append(lossFill, makeElement('b', '', `${Math.abs(row.drawdown).toFixed(1)}%`));
        const gain = makeElement('div', 'tradeoff-bar gain');
        const gainFill = makeElement('i');
        gainFill.style.width = `${Math.max(0, row.annual) / maxGain * 100}%`;
        gain.append(gainFill, makeElement('b', '', signed(row.annual)));
        item.append(label, loss, gain);
        if (row.extra) item.appendChild(makeElement('span', 'tradeoff-extra', row.extra));
        container.appendChild(item);
      });
    }

    function renderCorrelation(data) {
      const ids = data.correlation.ids;
      const matrix = $('#correlation-matrix');
      matrix.style.gridTemplateColumns = `86px repeat(${ids.length}, minmax(40px, 1fr))`;
      matrix.replaceChildren(makeElement('span', 'correlation-label', ''));
      ids.forEach((id) => matrix.appendChild(makeElement('span', 'correlation-label', bucketLabels[id])));
      const pairs = [];
      data.correlation.rows.forEach((row, rowIndex) => {
        matrix.appendChild(makeElement('span', 'correlation-label', bucketLabels[row.id]));
        row.values.forEach((value, colIndex) => {
          const cell = makeElement('span', 'correlation-cell', rowIndex === colIndex ? '—' : value.toFixed(2));
          const alpha = rowIndex === colIndex ? 0.08 : 0.12 + Math.abs(value) * 0.62;
          cell.style.background = value < 0.1 ? `rgba(66, 145, 157, ${alpha})` : `rgba(184, 135, 50, ${alpha})`;
          matrix.appendChild(cell);
          if (colIndex > rowIndex) pairs.push({ a: row.id, b: ids[colIndex], value });
        });
      });
      const describe = (value) => {
        if (value >= 0.6) return '经常一起涨跌';
        if (value >= 0.2) return '有一定联动';
        if (value >= 0.1) return '关系较弱';
        return '基本各走各的，甚至反着走';
      };
      const box = $('#corr-pairs');
      box.replaceChildren();
      const groupsOut = [
        ['放在一起，分散效果有限', [...pairs].sort((a, b) => b.value - a.value).slice(0, 2), 'together'],
        ['放在一起，能互相缓冲', [...pairs].sort((a, b) => a.value - b.value).slice(0, 3), 'apart']
      ];
      groupsOut.forEach(([title, list, tone]) => {
        const section = makeElement('div', `pair-group ${tone}`);
        section.appendChild(makeElement('h3', '', title));
        list.forEach((pair) => {
          const item = makeElement('div', 'pair');
          const names = makeElement('strong');
          names.append(document.createTextNode(bucketLabels[pair.a]), makeElement('i', '', tone === 'together' ? '⇄' : '⇅'), document.createTextNode(bucketLabels[pair.b]));
          item.append(names, makeElement('span', '', `${describe(pair.value)}（${pair.value.toFixed(2)}）`));
          section.appendChild(item);
        });
        box.appendChild(section);
      });
    }

    function renderHistory(data) {
      $('#history-common-window').textContent = `数据：${data.commonWindow.start.slice(0, 7)} 至 ${data.commonWindow.end.slice(0, 7)}，共 ${data.commonWindow.months} 个月，均为境内可买到的 ETF / 基金的人民币净值。`;
      $('#backtest-window').textContent = `${data.commonWindow.start.slice(0, 4)}–${data.commonWindow.end.slice(0, 4)} 年同一段历史，按推荐比例回测。`;
      initChart(data);
      tradeoffRows($('#tradeoff-assets'), data.assets.map((asset) => ({
        name: assetNames[asset.id] || asset.instrument, sub: `${asset.instrument} · 波动 ${asset.metrics.annualizedVolatility}%`,
        drawdown: asset.metrics.maxDrawdown, annual: asset.metrics.annualizedReturn, color: seriesColors[asset.id]
      })).sort((a, b) => a.drawdown - b.drawdown));
      tradeoffRows($('#tradeoff-profiles'), data.profileBacktests.map((profile) => ({
        name: profile.name, sub: `最差一年 ${profile.metrics.worstYear.year}：${signed(profile.metrics.worstYear.return)}`,
        drawdown: profile.metrics.maxDrawdown, annual: profile.metrics.annualizedReturn, color: seriesColors[profile.id],
        extra: `100 元 → ${profile.metrics.endingValue.toFixed(0)} 元`
      })));
      renderCorrelation(data);
      const methodology = $('#history-methodology-copy');
      methodology.replaceChildren();
      Object.values(data.methodology).forEach((copy) => methodology.appendChild(makeElement('p', '', copy)));
      const sources = $('#history-sources');
      sources.replaceChildren(makeElement('span', '', '数据与研究来源'));
      data.sources.forEach((source) => {
        const link = makeElement('a', '', source.name);
        link.href = source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        sources.appendChild(link);
      });
    }

    (async () => {
      try {
        const response = await fetch('data/historical-analysis.json', { cache: 'no-store' });
        if (!response.ok) throw new Error('history data unavailable');
        renderHistory(await response.json());
      } catch (_) {
        $('#history-common-window').textContent = '历史数据暂时无法载入，请稍后刷新。';
      }
    })();
  }

  const allocationPage = document.body.dataset.allocationPage;
  if (!allocationPage) return;
  let modelData;
  let implementationData;
  const allocationStorageKey = 'yuanjian-allocation-answers';
  const defaultAnswers = {
    horizon: 'fiveToTen',
    goal: 'growth',
    emergency: 'sixToTwelve',
    withdrawal: 'none',
    stability: 'normal',
    drawdown: 'twenty',
    reaction: 'hold',
    experience: 'stocks',
    access: 'domestic',
    currencyNeed: 'rmb',
    concentration: 'none'
  };
  const scoreNames = ['', '很低', '较低', '中等', '较高', '很高'];
  const textMaps = {
    horizon: { under3: '3 年以内', threeToFive: '3–5 年', fiveToTen: '5–10 年', overTen: '10 年以上' },
    goal: { preserve: '尽量保住本金', steady: '稳健积累', growth: '长期增长', income: '补充现金流' }
  };

  function readSavedAnswers() {
    try {
      return { ...defaultAnswers, ...JSON.parse(localStorage.getItem(allocationStorageKey) || '{}') };
    } catch (_) {
      return { ...defaultAnswers };
    }
  }

  const quizKeys = ['horizon', 'goal', 'withdrawal', 'emergency', 'stability', 'concentration', 'currencyNeed', 'drawdown', 'reaction', 'experience', 'access'];
  const toleranceKeys = ['drawdown', 'reaction', 'experience'];
  const capacityKeys = ['horizon', 'emergency', 'withdrawal', 'stability'];

  function readRawAnswers() {
    try {
      return JSON.parse(localStorage.getItem(allocationStorageKey) || '{}') || {};
    } catch (_) {
      return {};
    }
  }

  function hasCompletedQuiz() {
    const saved = readRawAnswers();
    return quizKeys.every((key) => Boolean(saved[key]));
  }

  function renderQuizMissing(container) {
    const box = makeElement('div', 'quiz-missing');
    box.append(
      makeElement('strong', '', '你还没有完成测评'),
      makeElement('p', '', '组合比例取决于你的用钱时间、应急金和能承受的波动。答完 11 个问题（约 3 分钟）后，这里会显示属于你的配置参考。')
    );
    const link = makeElement('a', 'primary-button', '开始测评');
    link.href = 'recommendation.html';
    box.appendChild(link);
    container.replaceChildren(box);
  }

  function saveAnswers(values) {
    localStorage.setItem(allocationStorageKey, JSON.stringify({ ...readRawAnswers(), ...values }));
  }

  function hydrateForm(form) {
    const answers = readSavedAnswers();
    form.querySelectorAll('select[name]').forEach((control) => {
      if (answers[control.name] !== undefined) control.value = answers[control.name];
    });
  }

  function collectForm(form) {
    return Object.fromEntries([...form.querySelectorAll('select[name]')].map((control) => [control.name, control.value]));
  }

  function weightedScore(values) {
    return Math.max(1, Math.min(5, Math.round(values.reduce((sum, item) => sum + item[0] * item[1], 0))));
  }

  function transfer(weights, fromIds, toIds, requestedAmount) {
    const available = fromIds.reduce((sum, id) => sum + Math.max(0, weights[id]), 0);
    const amount = Math.min(requestedAmount, available);
    if (!amount || !toIds.length) return;
    fromIds.forEach((id) => {
      const share = available ? Math.max(0, weights[id]) / available : 0;
      weights[id] = Math.max(0, weights[id] - amount * share);
    });
    toIds.forEach((id) => { weights[id] += amount / toIds.length; });
  }

  function roundToHundred(weights, bucketIds) {
    const raw = bucketIds.map((id) => ({ id, value: Math.max(0, weights[id]) }));
    const total = raw.reduce((sum, item) => sum + item.value, 0) || 1;
    const normalized = raw.map((item) => {
      const exact = item.value * 100 / total;
      return { id: item.id, floor: Math.floor(exact), fraction: exact - Math.floor(exact) };
    });
    let remaining = 100 - normalized.reduce((sum, item) => sum + item.floor, 0);
    normalized.sort((a, b) => b.fraction - a.fraction);
    for (let index = 0; index < remaining; index += 1) normalized[index % normalized.length].floor += 1;
    return Object.fromEntries(normalized.map((item) => [item.id, item.floor]));
  }

  function calculateProfile(overrides = {}) {
    const answers = { ...readSavedAnswers(), ...overrides };

    const tolerance = weightedScore([
      [{ five: 1, ten: 2, twenty: 3, thirty: 4, forty: 5 }[answers.drawdown], 0.45],
      [{ sellAll: 1, sellSome: 2, hold: 4, buy: 5 }[answers.reaction], 0.35],
      [{ cash: 1, funds: 2, stocks: 3, global: 5 }[answers.experience], 0.20]
    ]);
    const capacity = weightedScore([
      [{ under3: 1, threeToFive: 2, fiveToTen: 4, overTen: 5 }[answers.horizon], 0.35],
      [{ under3: 1, threeToSix: 2, sixToTwelve: 4, overTwelve: 5 }[answers.emergency], 0.25],
      [{ none: 5, under20: 3, twentyToFifty: 2, overFifty: 1 }[answers.withdrawal], 0.25],
      [{ fragile: 1, normal: 3, strong: 5 }[answers.stability], 0.15]
    ]);

    const caps = [];
    if (answers.horizon === 'under3') caps.push({ level: 1, reason: '投资期限不足 3 年' });
    if (answers.horizon === 'threeToFive') caps.push({ level: 3, reason: '投资期限只有 3–5 年' });
    if (answers.emergency === 'under3') caps.push({ level: 2, reason: '应急金不足 3 个月' });
    if (answers.withdrawal === 'twentyToFifty') caps.push({ level: 2, reason: '未来 3 年计划取出 20%–50%' });
    if (answers.withdrawal === 'overFifty') caps.push({ level: 1, reason: '未来 3 年计划取出超过一半' });
    if (answers.stability === 'fragile') caps.push({ level: 2, reason: '收入波动或债务压力较高' });
    if (answers.goal === 'preserve') caps.push({ level: 2, reason: '首要目标是保住本金' });
    if (answers.goal === 'steady') caps.push({ level: 3, reason: '首要目标是稳健积累' });
    if (answers.goal === 'income') caps.push({ level: 3, reason: '首要目标是补充现金流' });

    const scoreLevel = Math.min(tolerance, capacity);
    const level = Math.min(scoreLevel, ...caps.map((cap) => cap.level));
    const bindingReasons = caps.filter((cap) => cap.level < scoreLevel).map((cap) => cap.reason);
    const profile = modelData.profiles.find((item) => item.level === level);
    const weights = { ...profile.base };

    if (answers.goal === 'preserve') transfer(weights, ['china', 'global', 'reits'], ['cash', 'bonds'], 8);
    if (answers.goal === 'income') transfer(weights, ['china', 'global'], ['bonds', 'reits'], 6);
    if (answers.emergency === 'under3') transfer(weights, ['china', 'global', 'reits'], ['cash'], 10);
    if (answers.emergency === 'threeToSix') transfer(weights, ['china', 'global', 'reits'], ['cash'], 4);
    if (answers.withdrawal === 'under20') transfer(weights, ['china', 'global', 'reits'], ['cash'], 4);
    if (answers.withdrawal === 'twentyToFifty') transfer(weights, ['china', 'global', 'reits'], ['cash', 'bonds'], 10);
    if (answers.withdrawal === 'overFifty') transfer(weights, ['china', 'global', 'reits'], ['cash', 'bonds'], 16);
    if (answers.stability === 'fragile') transfer(weights, ['china', 'global', 'reits'], ['cash', 'bonds'], 8);
    if (answers.currencyNeed === 'foreign' && answers.access !== 'noOverseas') transfer(weights, ['china', 'bonds'], ['global'], 5);
    if (answers.concentration === 'property' && weights.reits > 3) transfer(weights, ['reits'], ['bonds'], weights.reits - 3);
    if (answers.concentration === 'chinaEquity' || answers.concentration === 'incomeChina') {
      transfer(weights, ['china'], [answers.access === 'noOverseas' ? 'bonds' : 'global'], 5);
    }
    if (answers.access === 'noOverseas') {
      const chinaConcentrated = answers.concentration === 'chinaEquity' || answers.concentration === 'incomeChina';
      transfer(weights, ['global'], chinaConcentrated ? ['bonds'] : ['bonds', 'china'], weights.global);
    }

    const bucketIds = modelData.buckets.map((item) => item.id);
    return { answers, tolerance, capacity, level, profile, weights: roundToHundred(weights, bucketIds), bindingReasons };
  }

  function rangeFor(weight) {
    if (weight === 0) return '0%（当前边界）';
    const spread = weight < 10 ? 3 : 5;
    return `${Math.max(0, weight - spread)}%–${Math.min(100, weight + spread)}%`;
  }

  function channelNote(bucketId, answers) {
    if (bucketId === 'global') {
      if (answers.access === 'noOverseas') return '当前选择暂不配置海外资产，因此目标为 0%；组合的地域分散会相应减弱。';
      if (answers.access === 'domestic') return '可通过境内 QDII 等渠道实现；买前核验额度、溢价、汇率和费率。';
      if (answers.access === 'connect') return '全球权益以 QDII 为主；港股通部分归入中国权益，不等于全球分散。';
      return '可比较境内 QDII 与合规境外账户成本，并另行核验跨境税务和规则。';
    }
    if (bucketId === 'china' && answers.access === 'domestic') return '以 A 股宽基为核心；如未开通港股通，可通过合规公募产品补充港股暴露。';
    if (bucketId === 'cash') return '这部分首先服务人民币生活与近期支出，不用收益率替代流动性要求。';
    return '';
  }

  function splitBucket(total, components, level, answers) {
    if (!total) return [];
    const eligible = components.filter((component) => {
      if (answers.access !== 'noOverseas') return true;
      return component.accessType !== 'foreign' && component.accessType !== 'hongKong';
    }).map((component) => ({ ...component, share: component.shares[level - 1] }));
    const active = eligible.filter((component) => component.share > 0);
    const shareTotal = active.reduce((sum, component) => sum + component.share, 0);
    if (!shareTotal) return [];
    const exact = active.map((component) => {
      const value = total * component.share / shareTotal;
      return { ...component, target: Math.floor(value), fraction: value - Math.floor(value) };
    });
    let remaining = total - exact.reduce((sum, component) => sum + component.target, 0);
    exact.sort((a, b) => b.fraction - a.fraction);
    for (let index = 0; index < remaining; index += 1) exact[index % exact.length].target += 1;
    return exact.sort((a, b) => b.target - a.target);
  }

  function vehicleFor(component, answers) {
    if (component.accessType === 'hongKong') {
      if (answers.access === 'connect') return '港股通 ETF / 港股通标的，或境内港股指数基金';
      if (answers.access === 'global') return '港股通、境内港股基金或合规境外账户';
      return '境内港股指数基金或 QDII；不要求开通港股通';
    }
    if (component.accessType === 'foreign' && answers.access === 'global') {
      return component.vehicle.replace('境内 QDII', 'QDII 或合规境外账户');
    }
    return component.vehicle;
  }

  function renderImplementationPlan(result) {
    const { answers, level, weights } = result;
    const plan = $('#detailed-plan');
    const checklist = $('#product-checklist');
    if (!plan || !implementationData) return;
    plan.replaceChildren();

    modelData.buckets.forEach((bucket) => {
      const definition = implementationData.buckets[bucket.id];
      const total = weights[bucket.id];
      const components = splitBucket(total, definition.components, level, answers);
      const details = document.createElement('details');
      details.className = 'plan-bucket';
      details.style.setProperty('--bucket-color', bucket.color);
      details.open = false;
      const summary = document.createElement('summary');
      const summaryCopy = document.createElement('div');
      summaryCopy.append(makeElement('span', '', '资产大类目标'), makeElement('strong', '', definition.title));
      const summaryWeight = makeElement('b', '', `${total}%`);
      summary.append(summaryCopy, summaryWeight);
      const body = document.createElement('div');
      body.className = 'plan-bucket-body';
      body.appendChild(makeElement('p', 'plan-rule', definition.rule));

      if (!components.length) {
        body.appendChild(makeElement('p', 'plan-empty', answers.access === 'noOverseas'
          ? '你选择暂不配置港股或海外资产，因此这一层当前不安排具体工具。'
          : '当前目标比例为 0%，暂不需要为这一类挑选产品。'));
      } else {
        components.forEach((component) => {
          const row = document.createElement('div');
          row.className = 'plan-component';
          const weight = makeElement('div', 'component-weight', `${component.target}%`);
          const name = document.createElement('div');
          name.className = 'component-name';
          name.appendChild(makeElement('strong', '', component.name));
          name.appendChild(makeElement('span', '', `占该大类约 ${Math.round(component.target / total * 100)}%`));
          const detail = document.createElement('a');
          detail.href = `asset-detail.html?id=${component.detailId}`;
          detail.textContent = '查看资产说明';
          name.appendChild(detail);
          const vehicle = document.createElement('div');
          vehicle.className = 'component-copy';
          vehicle.append(makeElement('strong', '', '可用载体'), makeElement('span', '', vehicleFor(component, answers)));
          const filter = document.createElement('div');
          filter.className = 'component-copy';
          filter.append(makeElement('strong', '', '筛选重点'), makeElement('span', '', component.filter));
          row.append(weight, name, vehicle, filter);
          body.appendChild(row);
        });
      }
      details.append(summary, body);
      plan.appendChild(details);
    });

    checklist.replaceChildren();
    implementationData.productChecklist.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'product-check-item';
      card.append(makeElement('strong', '', item.label), makeElement('span', '', item.detail));
      checklist.appendChild(card);
    });
    const satelliteMax = Math.max(1, Math.round((weights.china + weights.global) * 0.1));
    const satellite = $('#satellite-policy');
    satellite.querySelector('strong').textContent = `核心默认 0% · 上限约 ${satelliteMax}%`;
    satellite.querySelector('p').textContent = `${implementationData.satellitePolicy.default}${implementationData.satellitePolicy.limit}以你当前组合计算，上限约为总资产的 ${satelliteMax}%；${implementationData.satellitePolicy.funding}`;
  }

  function drawDonut(weights) {
    const svg = $('#allocation-donut');
    if (!svg) return;
    const ns = 'http://www.w3.org/2000/svg';
    const radius = 78;
    const circumference = 2 * Math.PI * radius;
    const gap = 1.6;
    let offset = 0;
    svg.replaceChildren();
    modelData.buckets.forEach((bucket) => {
      const weight = weights[bucket.id];
      if (!weight) return;
      const length = circumference * weight / 100;
      const circle = document.createElementNS(ns, 'circle');
      circle.setAttribute('cx', '100');
      circle.setAttribute('cy', '100');
      circle.setAttribute('r', String(radius));
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', bucket.color);
      circle.setAttribute('stroke-width', '26');
      circle.setAttribute('stroke-dasharray', `${Math.max(0, length - gap)} ${circumference}`);
      circle.setAttribute('stroke-dashoffset', String(-offset));
      circle.setAttribute('transform', 'rotate(-90 100 100)');
      const title = document.createElementNS(ns, 'title');
      title.textContent = `${bucket.shortName} ${weight}%`;
      circle.appendChild(title);
      svg.appendChild(circle);
      offset += length;
    });
    const equity = $('#donut-equity');
    if (equity) equity.textContent = `${weights.china + weights.global}%`;
  }

  function renderAllocation(result) {
    const { answers, tolerance, capacity, profile, weights, bindingReasons } = result;
    $('#profile-name').textContent = profile.name;
    $('#profile-description').textContent = profile.description;
    $('#tolerance-score').textContent = `${tolerance} / 5 · ${scoreNames[tolerance]}`;
    $('#capacity-score').textContent = `${capacity} / 5 · ${scoreNames[capacity]}`;
    $('#stress-range').textContent = `教育型压力情景：${profile.stress}`;
    $('#rebalance-rule').textContent = profile.review;

    const constraint = $('#constraint-note');
    if (bindingReasons.length) {
      constraint.innerHTML = `<strong>为什么更保守：</strong>${bindingReasons.join('、')}，所以最终档位比两项评分更低一档或几档。`;
    } else if (capacity < tolerance) {
      constraint.innerHTML = '<strong>风险能力更低：</strong>你愿意承受的波动高于当前财务条件，最终画像按风险能力确定。';
    } else if (tolerance < capacity) {
      constraint.innerHTML = '<strong>风险意愿更低：</strong>你的财务条件可以承担更多波动，但组合尊重你真实的心理边界。';
    } else {
      constraint.innerHTML = '<strong>两项匹配：</strong>你的风险意愿与风险能力处在同一档，最终画像未被额外下调。';
    }

    const defensive = weights.cash + weights.bonds;
    const growth = weights.china + weights.global + weights.reits;
    $('#result-summary').textContent = `这是面向“${textMaps.horizon[answers.horizon]}、${textMaps.goal[answers.goal]}”的${profile.name}学习草案：稳定层 ${defensive}%，增长层 ${growth}%，黄金 / 商品分散层 ${weights.gold}%。实际执行前仍需把三年内确定用款单独隔离。`;

    const chart = $('#allocation-chart');
    const legend = $('#allocation-legend');
    const cards = $('#allocation-cards');
    if (chart) chart.replaceChildren();
    legend.replaceChildren();
    cards.replaceChildren();
    drawDonut(weights);

    modelData.buckets.forEach((bucket) => {
      const weight = weights[bucket.id];
      const piece = document.createElement('span');
      piece.className = 'chart-piece';
      piece.style.width = `${weight}%`;
      piece.style.background = bucket.color;
      piece.title = `${bucket.name} ${weight}%`;
      if (chart) chart.appendChild(piece);

      const legendItem = document.createElement('div');
      legendItem.className = 'legend-item';
      const legendName = document.createElement('span');
      const dot = document.createElement('i');
      dot.className = 'legend-dot';
      dot.style.background = bucket.color;
      legendName.append(dot, document.createTextNode(bucket.shortName));
      if (legend.classList.contains('legend-v2')) legendName.appendChild(makeElement('small', '', bucket.role));
      const percent = document.createElement('b');
      percent.textContent = `${weight}%`;
      legendItem.append(legendName, percent);
      legend.appendChild(legendItem);

      const card = document.createElement('article');
      card.className = 'allocation-card';
      card.style.setProperty('--bucket-color', bucket.color);
      const head = document.createElement('div');
      const titleWrap = document.createElement('div');
      const role = document.createElement('span');
      role.textContent = bucket.role;
      const title = document.createElement('h4');
      title.textContent = bucket.name;
      titleWrap.append(role, title);
      const target = document.createElement('strong');
      target.textContent = `${weight}%`;
      head.append(titleWrap, target);
      const detail = document.createElement('p');
      detail.textContent = bucket.detail;
      const range = document.createElement('small');
      range.textContent = `参考浮动区间 ${rangeFor(weight)}`;
      const links = document.createElement('div');
      links.className = 'allocation-links';
      bucket.links.forEach((item) => {
        const link = document.createElement('a');
        link.href = `asset-detail.html?id=${item.id}`;
        link.textContent = `${item.label} →`;
        links.appendChild(link);
      });
      card.append(head, detail, range, links);
      const noteText = channelNote(bucket.id, answers);
      if (noteText) {
        const note = document.createElement('p');
        note.className = 'bucket-note';
        note.textContent = noteText;
        card.appendChild(note);
      }
      cards.appendChild(card);
    });

    const why = $('#why-list');
    why.replaceChildren();
    const reasons = [
      `风险意愿为 ${tolerance}/5，风险能力为 ${capacity}/5；最终采用更谨慎的一侧，并让期限与近期用款拥有否决权。`,
      `人民币现金与优质债券合计 ${defensive}%，用于匹配本币支出、缓冲波动，并为再平衡保留资金。`,
      `中国权益 ${weights.china}% 与全球权益 ${weights.global}% 分担增长来源；港股属于中国风险暴露，不能替代真正的全球分散。`,
      answers.concentration === 'property'
        ? '你已提示房产集中，因此 REITs 比例被压低，避免在家庭资产中继续叠加不动产风险。'
        : answers.concentration === 'chinaEquity' || answers.concentration === 'incomeChina'
          ? '你已提示中国相关集中风险，因此减少中国权益，并把空间让给全球权益或人民币债券。'
          : `REITs 与黄金 / 商品合计 ${weights.reits + weights.gold}%，只承担小比例分散职责，不被当作确定保本工具。`
    ];
    if (answers.access === 'noOverseas') reasons.push('你选择暂不使用港股或海外资产，因此全球权益为 0%；这提高了执行便利，但牺牲了地域与货币分散。');
    reasons.forEach((reason) => {
      const item = document.createElement('li');
      item.textContent = reason;
      why.appendChild(item);
    });
    renderImplementationPlan(result);
  }

  async function renderBacktestNote(result) {
    const target = $('#backtest-note');
    if (!target) return;
    try {
      const response = await fetch('data/historical-analysis.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('history unavailable');
      const data = await response.json();
      const match = data.profileBacktests.find((item) => item.id === result.profile.id);
      if (!match) throw new Error('profile missing');
      const period = data.commonWindow;
      target.textContent = `同档基准组合在 ${period.start.slice(0, 7)} 至 ${period.end.slice(0, 7)} 的历史回测中，按月末数据最大回撤约 ${match.metrics.maxDrawdown}%。这段历史没有经历 2008 年那样的全球危机，月末数据也会把盘中跌幅算浅，所以压力区间刻意设得更宽。`;
    } catch (_) {
      target.textContent = '压力区间参考的是比近十年更极端的情景，因此比历史回测的回撤更深。';
    }
  }

  async function renderMarketContext(result) {
    if (!$('#market-context-time') || !$('#market-rationale')) return;
    const { answers, profile } = result;
    const horizonText = textMaps.horizon[answers.horizon] || '';
    const emergencyText = { under3: '不到 3 个月', threeToSix: '3–6 个月', sixToTwelve: '6–12 个月', overTwelve: '12 个月以上' }[answers.emergency] || '';
    const drawdownText = { five: '约 5%', ten: '约 10%', twenty: '约 20%', thirty: '约 30%', forty: '40% 以上' }[answers.drawdown] || '';
    // 压力情景形如“约 -18% 至 -28%”，取较小的那个跌幅做对比
    const stressFloor = Math.min(...(String(profile.stress).match(/\d+(\.\d+)?/g) || ['0']).map(Number));
    const reasons = (move) => {
      let volatility = `设计“${profile.name}”时，已经预期整个组合在不利的年份可能出现${profile.stress}的波动，短期涨跌本来就在计划之内。`;
      if (Number.isFinite(move)) {
        const moveText = `沪深 300 近 20 个交易日${move >= 0 ? '上涨' : '下跌'} ${Math.abs(move).toFixed(2)}%`;
        volatility += Math.abs(move) < stressFloor
          ? `${moveText}，这是单个市场一个月的变化，幅度小于这个预期。`
          : `${moveText}，幅度已经不小，可以按第 3 条检查自己的持仓是否偏离目标。`;
      }
      return [
        ['比例由你的情况决定', `你的比例取决于投资期限（${horizonText}）、应急金（${emergencyText}）和能承受的一年最大跌幅（${drawdownText}）。上面的行情数字没有改变其中任何一项。`],
        ['这类波动已经算进去了', volatility],
        ['什么时候才需要调整', `${profile.review}。要不要调整，看的是你自己的持仓比例，而不是某个指数的涨跌；只有期限、用钱计划或应急金变了，才需要重新回答问题。`]
      ];
    };
    const renderReasons = (move) => {
      const list = $('#market-reasons');
      if (!list) return;
      list.replaceChildren(...reasons(move).map(([title, body]) => {
        const item = makeElement('li');
        item.append(makeElement('strong', '', title), makeElement('span', '', body));
        return item;
      }));
    };
    try {
      const response = await fetch('data/market-details.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('market data unavailable');
      const data = await response.json();
      const byId = Object.fromEntries(data.markets.map((market) => [market.id, market]));
      const aShare = byId['a-share'].headline;
      const fx = byId.fx.headline;
      const globalRisk = byId['global-risk'].headline;
      // marketContext 由 update_market.py 按当天数据生成；没有时只列数字
      const context = typeof data.marketContext === 'object' && data.marketContext ? data.marketContext : {};
      const text = context.text || `沪深 300 ${aShare.value}（${aShare.change}），${fx.label} ${fx.value}，${globalRisk.label} ${globalRisk.value}。`;
      $('#market-context-time').textContent = `${data.updatedAt} · ${data.timezone}`;
      $('#market-rationale').replaceChildren(makeElement('strong', '', '当前公开数据：'), document.createTextNode(text));
      renderReasons(Number.isFinite(context.csi300Change20d) ? context.csi300Change20d : NaN);
    } catch (_) {
      $('#market-context-time').textContent = '数据暂不可用';
      $('#market-rationale').replaceChildren(makeElement('strong', '', '市场数据暂未载入：'), document.createTextNode('不影响下面的判断。'));
      renderReasons(NaN);
    }
  }

  function renderProfilePreview(result) {
    $('#preview-tolerance').textContent = `${result.tolerance} / 5`;
    $('#preview-tolerance-name').textContent = scoreNames[result.tolerance];
    $('#preview-capacity').textContent = `${result.capacity} / 5`;
    $('#preview-capacity-name').textContent = scoreNames[result.capacity];
    $('#preview-profile-name').textContent = result.profile.name;
    const reason = $('#preview-profile-reason');
    if (result.bindingReasons.length) {
      reason.textContent = `${result.bindingReasons.join('、')}，所以最终档位比两项评分更保守。`;
    } else if (result.capacity < result.tolerance) {
      reason.textContent = '风险能力低于风险意愿，最终按财务承受力确定。';
    } else if (result.tolerance < result.capacity) {
      reason.textContent = '风险意愿低于风险能力，组合尊重你的心理边界。';
    } else {
      reason.textContent = '风险意愿与风险能力处在同一档。';
    }
  }

  function renderReview(result) {
    $('#review-profile').textContent = `${result.profile.name}组合`;
    $('#review-rule').textContent = result.profile.review;
    const targets = $('#review-targets');
    targets.replaceChildren();
    modelData.buckets.forEach((bucket) => {
      const item = document.createElement('div');
      const label = document.createElement('span');
      const dot = document.createElement('i');
      dot.style.background = bucket.color;
      label.append(dot, document.createTextNode(bucket.shortName));
      item.append(label, makeElement('strong', '', `${result.weights[bucket.id]}%`));
      targets.appendChild(item);
    });
  }

  function initQuiz() {
    const form = $('#quiz-form');
    if (!form) return;
    const saved = readRawAnswers();
    quizKeys.forEach((key) => {
      if (!saved[key]) return;
      const input = form.querySelector(`input[name="${key}"][value="${saved[key]}"]`);
      if (input) input.checked = true;
    });

    const collect = () => {
      const answers = {};
      form.querySelectorAll('input[type="radio"]:checked').forEach((input) => { answers[input.name] = input.value; });
      return answers;
    };

    const setMeter = (id, score) => {
      const row = $(id);
      row.querySelectorAll('.meter i').forEach((dot, index) => dot.classList.toggle('on', score !== null && index < score));
      row.querySelector('strong').textContent = score === null ? '—' : `${score} / 5 · ${scoreNames[score]}`;
    };

    const update = () => {
      const answers = collect();
      const count = quizKeys.filter((key) => answers[key]).length;
      document.querySelectorAll('.quiz-count').forEach((node) => { node.textContent = count; });
      document.querySelectorAll('.quiz-bar').forEach((node) => { node.style.width = `${count / quizKeys.length * 100}%`; });
      form.querySelectorAll('.quiz-q').forEach((fieldset) => {
        const answered = Boolean(answers[fieldset.dataset.q]);
        fieldset.classList.toggle('answered', answered);
        if (answered) fieldset.classList.remove('needs-answer');
      });

      const result = calculateProfile(answers);
      setMeter('#tolerance-meter', toleranceKeys.every((key) => answers[key]) ? result.tolerance : null);
      setMeter('#capacity-meter', capacityKeys.every((key) => answers[key]) ? result.capacity : null);

      const complete = count === quizKeys.length;
      const bar = $('#quiz-mini-bar');
      const legend = $('#quiz-mini-legend');
      document.querySelectorAll('.quiz-submit').forEach((button) => {
        button.classList.toggle('is-disabled', !complete);
        button.setAttribute('aria-disabled', String(!complete));
        button.textContent = complete ? '生成我的组合' : `还差 ${quizKeys.length - count} 题`;
      });
      if (!complete) {
        $('#quiz-profile-name').textContent = '答完后显示';
        $('#quiz-profile-reason').textContent = '两项取更谨慎的一边，用钱时间和应急金还有一票否决权。';
        bar.hidden = true;
        legend.hidden = true;
        return;
      }
      $('#quiz-profile-name').textContent = result.profile.name;
      if (result.bindingReasons.length) {
        $('#quiz-profile-reason').textContent = `${result.bindingReasons.join('、')}，所以比两项评分更保守。`;
      } else if (result.capacity < result.tolerance) {
        $('#quiz-profile-reason').textContent = '你愿意冒的险，比家底能扛的多，按家底来定。';
      } else if (result.tolerance < result.capacity) {
        $('#quiz-profile-reason').textContent = '家底能扛更多波动，但组合尊重你心里的底线。';
      } else {
        $('#quiz-profile-reason').textContent = '两项处在同一档。';
      }
      bar.replaceChildren();
      legend.replaceChildren();
      modelData.buckets.forEach((bucket) => {
        const weight = result.weights[bucket.id];
        if (!weight) return;
        const piece = makeElement('span');
        piece.style.flex = String(weight);
        piece.style.background = bucket.color;
        piece.title = `${bucket.shortName} ${weight}%`;
        bar.appendChild(piece);
        const item = makeElement('span');
        const dot = makeElement('i');
        dot.style.background = bucket.color;
        item.append(dot, document.createTextNode(`${bucket.shortName} ${weight}%`));
        legend.appendChild(item);
      });
      bar.hidden = false;
      legend.hidden = false;
    };

    let quizStarted = false;
    form.addEventListener('change', () => {
      if (!quizStarted) {
        quizStarted = true;
        track('问卷', '开始答题');
      }
      saveAnswers(collect());
      update();
    });
    document.querySelectorAll('.quiz-submit').forEach((button) => button.addEventListener('click', (event) => {
      const answers = collect();
      const missing = quizKeys.find((key) => !answers[key]);
      if (!missing) {
        saveAnswers(answers);
        const result = calculateProfile(answers);
        track('问卷', '完成', result.profile.name);
        quizKeys.forEach((key) => {
          const input = form.querySelector(`input[name="${key}"]:checked`);
          const question = form.querySelector(`[data-q="${key}"] legend`);
          const option = input && input.closest('label').querySelector('strong');
          if (question && option) track('问卷答案', question.textContent, option.textContent);
        });
        if (ANALYTICS_BAIDU_ID) {
          // 给统计请求留一点发送时间，再跳转
          event.preventDefault();
          setTimeout(() => { window.location.href = button.getAttribute('href'); }, 250);
        }
        return;
      }
      event.preventDefault();
      const fieldset = form.querySelector(`[data-q="${missing}"]`);
      fieldset.classList.remove('needs-answer');
      void fieldset.offsetWidth;
      fieldset.classList.add('needs-answer');
      fieldset.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
    update();
  }

  async function initAllocation() {
    try {
      const [modelResponse, implementationResponse] = await Promise.all([
        fetch('data/allocation-models.json'),
        fetch('data/implementation-models.json')
      ]);
      if (!modelResponse.ok || !implementationResponse.ok) throw new Error('allocation model unavailable');
      modelData = await modelResponse.json();
      implementationData = await implementationResponse.json();
      if (allocationPage === 'quiz') initQuiz();
      if (allocationPage === 'constraints') {
        const constraintsForm = $('#constraints-form');
        hydrateForm(constraintsForm);
        const persistConstraints = () => saveAnswers(collectForm(constraintsForm));
        constraintsForm.querySelectorAll('select').forEach((control) => control.addEventListener('change', persistConstraints));
        $('#constraints-next').addEventListener('click', persistConstraints);
      }
      if (allocationPage === 'profile') {
        const profileForm = $('#risk-profile-form');
        hydrateForm(profileForm);
        const preview = () => renderProfilePreview(calculateProfile(collectForm(profileForm)));
        profileForm.querySelectorAll('select').forEach((control) => control.addEventListener('change', () => {
          saveAnswers(collectForm(profileForm));
          preview();
        }));
        $('#profile-next').addEventListener('click', () => saveAnswers(collectForm(profileForm)));
        preview();
      }
      if (allocationPage === 'portfolio') {
        if (!hasCompletedQuiz()) {
          renderQuizMissing($('.portfolio-result'));
          const actions = $('.wizard-bottom-actions');
          if (actions) actions.hidden = true;
          return;
        }
        const result = calculateProfile();
        renderAllocation(result);
        track('组合', '查看', result.profile.name);
        renderBacktestNote(result);
        renderMarketContext(result);
      }
      if (allocationPage === 'review') {
        if (!hasCompletedQuiz()) {
          renderQuizMissing($('.review-hero'));
          const layout = $('.review-layout');
          if (layout) layout.hidden = true;
          return;
        }
        renderReview(calculateProfile());
      }
    } catch (_) {
      const status = $('#result-summary') || $('#review-rule') || $('#preview-profile-reason');
      if (status) status.textContent = '配置模型暂时无法载入，请稍后刷新。';
    }
  }

  initAllocation();
})();
