#!/usr/bin/env python3
"""用 Claude API（带联网搜索）生成每日文字部分：

  * data/news.json            首页“今日主线”和 3 条消息
  * data/market-details.json  每个市场的 summary（一段话）和 signals（3 条解读）

在 update_market.py 之后运行：成功时覆盖它按数字生成的模板 summary 和通用 signals。
需要环境变量 ANTHROPIC_API_KEY（在 GitHub 仓库 Settings → Secrets 里添加）。
没有密钥时直接退出，网站继续显示上一次的文字。

用法：
  python scripts/update_commentary.py           # 生成并写入
  python scripts/update_commentary.py --check   # 只打印结果，不写文件
"""
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MARKET_FILE = ROOT / "data" / "market-details.json"
NEWS_FILE = ROOT / "data" / "news.json"
BEIJING = timezone(timedelta(hours=8))
MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-5-5")
API_URL = "https://api.anthropic.com/v1/messages"

SYSTEM = """你是“远见配置”网站的市场解读编辑。网站面向中国内地散户，做全球资产配置的投资教育。
写作要求：
- 简体中文，平实易懂，像跟普通人讲话，避免术语堆砌。
- 只解释“发生了什么、可能影响哪类资产、对长期配置意味着什么”，绝不给出买入、卖出、加仓、抄底等交易建议，不预测涨跌，不推荐具体基金或股票。
- 反复强调：短期消息不应改变长期配置比例。
- 新闻优先引用中国内地可正常访问的权威来源（新华社、中国政府网、人民银行、证监会、外汇局、交易所、新华财经等）；只能使用你通过搜索真实看到的链接，不得编造网址。
- 数字以用户提供的行情数据为准，不要自行改写数字。
最后只输出一个 JSON 对象，不要任何其他文字或 Markdown 代码块。"""

SCHEMA_HINT = """输出 JSON 结构：
{
  "thesis": "今日主线，一到两句话，不超过 90 字",
  "news": [
    {"date": "YYYY-MM-DD", "category": "政策 / A 股 / 港股 / 汇率 / 海外 / 投资者保护 等", "source": "来源机构名",
     "title": "标题，不超过 30 字", "summary": "两三句话：发生了什么 + 对散户配置的含义，不超过 110 字", "url": "https://..."}
  ],
  "markets": {
    "a-share": {"summary": "不超过 110 字", "signals": [{"title": "不超过 8 字", "body": "不超过 70 字"}]},
    "hong-kong": {...}, "fx": {...}, "global-risk": {...}
  }
}
news 恰好 3 条，每个市场的 signals 恰好 3 条。"""


def call_claude(prompt, api_key):
    body = {
        "model": MODEL,
        "max_tokens": 4000,
        "system": SYSTEM,
        "messages": [{"role": "user", "content": prompt}],
        "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 8}],
    }
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json", "x-api-key": api_key, "anthropic-version": "2023-06-01"},
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    text = "".join(block.get("text", "") for block in payload.get("content", []) if block.get("type") == "text")
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError("模型没有返回 JSON")
    return json.loads(match.group(0))


def validate(result):
    assert isinstance(result.get("thesis"), str) and result["thesis"].strip(), "缺少 thesis"
    news = result.get("news")
    assert isinstance(news, list) and len(news) == 3, "news 必须恰好 3 条"
    for item in news:
        for key in ("date", "category", "source", "title", "summary", "url"):
            assert isinstance(item.get(key), str) and item[key].strip(), f"news 缺少 {key}"
        assert item["url"].startswith("https://") or item["url"].startswith("http://"), "news.url 必须是网址"
    banned = ["加仓", "抄底", "清仓", "满仓", "推荐购买", "建议买入", "建议卖出"]
    blob = json.dumps(result, ensure_ascii=False)
    hits = [word for word in banned if word in blob]
    assert not hits, f"出现交易指令用词：{hits}"
    for market_id in ("a-share", "hong-kong", "fx", "global-risk"):
        market = result.get("markets", {}).get(market_id)
        assert market and isinstance(market.get("summary"), str), f"缺少 {market_id}.summary"
        signals = market.get("signals")
        assert isinstance(signals, list) and len(signals) == 3, f"{market_id}.signals 必须 3 条"
        for signal in signals:
            assert signal.get("title") and signal.get("body"), f"{market_id}.signals 格式错误"


def main():
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        print("未设置 ANTHROPIC_API_KEY，跳过文字更新。", file=sys.stderr)
        return 0
    check_only = "--check" in sys.argv
    now = datetime.now(BEIJING)
    market_data = json.loads(MARKET_FILE.read_text(encoding="utf-8"))
    numbers = {
        m["id"]: {"headline": m["headline"], "metrics": [{k: x[k] for k in ("label", "value", "change")} for x in m["metrics"]]}
        for m in market_data["markets"]
    }
    prompt = (
        f"今天是 {now:%Y-%m-%d}（北京时间）。下面是网站今天自动抓取的行情数据：\n"
        f"{json.dumps(numbers, ensure_ascii=False, indent=1)}\n\n"
        "请先搜索过去 48 小时内与中国内地散户全球资产配置相关的重要新闻（中国政策与 A 股、港股、人民币汇率、美债利率与油价、投资者保护等），"
        "挑出最值得关注的 3 条，再结合上面的数据，为四个市场各写一段说明和 3 条解读。\n"
        "如遇休市，请在解读中说明数据为最近交易日。\n\n" + SCHEMA_HINT
    )
    try:
        result = call_claude(prompt, api_key)
        validate(result)
    except Exception as error:  # noqa: BLE001
        print(f"文字更新失败，保留上一次内容：{error}", file=sys.stderr)
        return 0

    news = {"updatedAt": f"{now:%Y-%m-%d}", "thesis": result["thesis"].strip(), "items": result["news"]}
    for market in market_data["markets"]:
        generated = result["markets"][market["id"]]
        market["summary"] = generated["summary"].strip()
        market["signals"] = [{"title": s["title"].strip(), "body": s["body"].strip()} for s in generated["signals"]]
    market_data["commentaryUpdatedAt"] = f"{now:%Y-%m-%d}"

    if check_only:
        print(json.dumps({"news": news, "markets": result["markets"]}, ensure_ascii=False, indent=2))
        return 0
    NEWS_FILE.write_text(json.dumps(news, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    MARKET_FILE.write_text(json.dumps(market_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("文字部分已更新。", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
