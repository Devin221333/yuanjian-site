# 远见配置 · 项目说明（给 Claude Code 看的）

面向中国内地散户的全球资产配置教育网站。纯静态站点（HTML + CSS + 原生 JS），无构建步骤，无后端。

## 目录结构
- `*.html`：9 个页面。index 首页 / assets 资产地图 / asset-detail 资产档案 / analysis 历史验证 /
  recommendation 问卷（第 1 步）/ portfolio 组合（第 2 步）/ review 复核（第 3 步）/ market-detail 市场详情 / privacy 隐私说明。
  profile.html 只是跳转到 recommendation.html 的旧链接兼容页。
- `app.js`：所有页面共用的脚本，按页面里存在的元素决定执行哪段逻辑。
- `style.css` + `daily.css`：样式。daily.css 末尾按版本（v16…v22）追加，后面的规则覆盖前面的。
- `data/*.json`：全部内容数据。页面通过 `fetch('data/xxx.json')` 读取。
- `scripts/update_market.py`：每日抓行情数字写入 data/market-details.json（只用标准库）。
- `scripts/update_commentary.py`：调用 Claude API（带 web search）生成首页新闻 data/news.json 和各市场文字解读。
- `.github/workflows/daily-update.yml`：工作日北京时间 16:40 自动运行上面两个脚本并提交。

## 必须遵守的规则
- **电脑端和手机端都要改，而且布局要按各自的使用习惯分别设计**，不是简单缩小。断点：`max-width: 900px` 为手机端。
  已有模式：电脑端侧边固定面板 ↔ 手机端底部弹出卡片；电脑端并排两栏 ↔ 手机端标签切换；横向滑动标签/卡片用于手机。
- **红涨绿跌**（A 股习惯）：上涨/收益用红色，下跌/回撤用绿色。
- 只做投资教育：不推荐具体基金、股票，不给买卖指令，不预测涨跌。文案避免“抄底、加仓、满仓”等词。
- 文案用平实中文，标题用问句或口语，不用英文小标题。
- 数据文件的字段结构不要随意改；如必须改，同步修改 app.js 的读取逻辑和两个更新脚本。
- 改完 CSS/JS 后，把所有 HTML 里的 `?v=数字` 版本号加 1，避免用户浏览器缓存旧文件。

## 待办：让自动更新真正跑起来
1. ✅ 已于 2026-10-01 验证 `python scripts/update_market.py --check`，所有数据源可用：
   - A 股 / 港股指数改为腾讯行情 qt.gtimg.cn 为主、东方财富为备用（东方财富 push2 从海外网络测试时持续 502，GitHub Actions 也在海外，需在首次运行时确认）。
   - 美国财政部收益率 CSV、外汇交易中心 ccpr.json（字段 vrtEName / price 已确认）、FRED 原油均正常。
   - 收盘日期取自行情返回的时间，不再用运行当天；数值没变的项不算更新，休市日不会产生空提交。
   - 免费模式：update_market.py 会按当天数字用模板重写各市场 summary，并使用长期适用的 signals，不调用 API。
2. （可选，会产生 API 费用，目前不启用）设置 `ANTHROPIC_API_KEY` 后运行 `python scripts/update_commentary.py --check`，检查生成的新闻和解读质量、链接真实性。
3. 建 GitHub 仓库，推送代码，在 Actions 页面手动运行一次工作流（不添加 `ANTHROPIC_API_KEY` 也能跑，文字解读一步会自动跳过）。
   注意：首页 data/news.json 的新闻和“今日主线”只有启用 API 后才会更新，免费模式下保持手写内容。
4. 根据网站托管位置配置发布：
   - Cloudflare Pages / Netlify / Vercel 等可直接连 GitHub 自动部署；
   - 国内云（需 ICP 备案）在工作流末尾加上传步骤（ossutil / coscmd / rsync）。
5. 历史数据 data/historical-analysis.json 目前是手工生成的，可另写脚本按月更新。

## 其他
- 统计：app.js 顶部 `ANALYTICS_BAIDU_ID` 填入百度统计 ID 后生效，事件用 `track(分类, 动作, 标签)` 上报。
- 本地预览：在项目目录运行 `python3 -m http.server`，打开 http://localhost:8000（直接双击 HTML 会因为 fetch 读不到 data 文件而空白）。
