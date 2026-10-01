#!/usr/bin/env python3
"""每日自动更新 data/market-details.json 里的行情数字。

改数字（点位、涨跌幅、成交额、汇率、收益率、油价和日期），并按数字用模板
重写每个市场的 summary（免费，不调用 API）。更丰富的解读由 update_commentary.py
（需要 ANTHROPIC_API_KEY）在之后覆盖。

用法：
  python scripts/update_market.py           # 抓取并写入
  python scripts/update_market.py --check   # 只抓取并打印，不写文件（调试数据源用）

设计原则：
  * 任何一个数据源失败，只跳过那一项，保留旧值，其余照常更新。
  * 新值和旧值差得离谱（见 SANITY）时判定为异常，不写入。
  * 只用 Python 标准库，GitHub Actions 里无需安装依赖。

数据源（2026-10 已验证）：
  * A 股 / 港股指数：腾讯行情 qt.gtimg.cn 为主，东方财富 push2 为备用
    （东方财富在海外机房（含 GitHub Actions）经常返回 502）。
  * 美债 10 年：美国财政部收益率 CSV，失败回退 FRED DGS10。
  * 人民币中间价：中国外汇交易中心 ccpr.json（字段 vrtEName / price）。
  * 原油：FRED DCOILBRENTEU / DCOILWTICO，通常滞后数个交易日。
"""
import csv
import io
import json
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "market-details.json"
BEIJING = timezone(timedelta(hours=8))
UA = {"User-Agent": "Mozilla/5.0 (yuanjian-allocation data updater)"}

# 允许的单日最大变化（超过就当作数据源出错，不写入）
SANITY = {"index": 0.12, "fx": 0.03, "yield_pt": 0.6, "oil": 0.25}


def http_get(url, referer=None, timeout=20, encoding="utf-8", attempts=3):
    headers = dict(UA)
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode(encoding, errors="replace")
        except Exception:  # noqa: BLE001
            if attempt == attempts - 1:
                raise
            time.sleep(3 * (attempt + 1))


def log(msg):
    print(msg, file=sys.stderr)


# ---------------------------------------------------------------- 数据源
# 腾讯行情（非官方公开接口）：以 ~ 分隔，[3]=最新价 [30]=时间 [32]=涨跌幅% [37]=成交额(万元)
TENCENT_CODES = {
    "csi300": "sh000300",
    "sse": "sh000001",
    "szse": "sz399001",
    "hsi": "hkHSI",
    "hscei": "hkHSCEI",
    "hstech": "hkHSTECH",
}


def fetch_tencent():
    text = http_get("https://qt.gtimg.cn/q=" + ",".join(TENCENT_CODES.values()), encoding="gbk")
    fields_by_code = {}
    for line in text.split(";"):
        if "=" not in line:
            continue
        name, _, raw = line.strip().partition("=")
        fields_by_code[name.removeprefix("v_")] = raw.strip('"').split("~")
    out = {}
    for key, code in TENCENT_CODES.items():
        f = fields_by_code.get(code)
        if not f or len(f) < 38:
            continue
        digits = "".join(ch for ch in f[30] if ch.isdigit())[:8]  # 20260930161412 或 2026/09/30 16:08:50
        out[key] = {"value": float(f[3]), "pct": float(f[32]), "amount": float(f[37] or 0) * 1e4,
                    "date": f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}"}
    return out


# 备用：东方财富行情接口（非官方公开接口，字段含义可能调整）
# f2=最新价 f3=涨跌幅% f6=成交额(元) f12=代码 f14=名称 f124=更新时间戳；fltt=2 表示返回小数
EASTMONEY_SECIDS = {
    "csi300": "1.000300",   # 沪深300
    "sse": "1.000001",      # 上证指数
    "szse": "0.399001",     # 深证成指
    "hsi": "100.HSI",       # 恒生指数
    "hscei": "100.HSCEI",   # 国企指数
    "hstech": "124.HSTECH", # 恒生科技（secid 待验证）
}


def fetch_eastmoney():
    secids = ",".join(EASTMONEY_SECIDS.values())
    url = ("https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2"
           f"&fields=f2,f3,f6,f12,f14,f124&secids={secids}")
    payload = json.loads(http_get(url, referer="https://quote.eastmoney.com/"))
    rows = (payload.get("data") or {}).get("diff") or []
    by_code = {str(row.get("f12")): row for row in rows}
    out = {}
    for key, secid in EASTMONEY_SECIDS.items():
        row = by_code.get(secid.split(".", 1)[1])
        if row and isinstance(row.get("f2"), (int, float)):
            stamp = datetime.fromtimestamp(int(row.get("f124") or 0), BEIJING) if row.get("f124") else None
            out[key] = {"value": float(row["f2"]), "pct": float(row.get("f3") or 0),
                        "amount": float(row.get("f6") or 0), "date": f"{stamp:%Y-%m-%d}" if stamp else ""}
    return out


def fetch_index_quotes():
    """先腾讯，缺的项再用东方财富补。"""
    quotes = {}
    for name, fetcher in (("tencent", fetch_tencent), ("eastmoney", fetch_eastmoney)):
        if len(quotes) == len(TENCENT_CODES):
            break
        try:
            got = fetcher()
            log(f"[{name}] {got}")
            for key, quote in got.items():
                quotes.setdefault(key, quote)
        except Exception as error:  # noqa: BLE001
            log(f"[{name}] 失败：{error}")
    return quotes


def fetch_treasury_10y(today):
    """美国财政部官方每日收益率曲线 CSV（待验证 URL 格式）。失败时回退 FRED。"""
    year = today.year
    url = ("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/"
           f"daily-treasury-rates.csv/{year}/all?type=daily_treasury_yield_curve"
           f"&field_tdr_date_value={year}&page&_format=csv")
    try:
        rows = list(csv.DictReader(io.StringIO(http_get(url))))
        latest = max(rows, key=lambda r: datetime.strptime(r["Date"], "%m/%d/%Y"))
        date = datetime.strptime(latest["Date"], "%m/%d/%Y").date()
        return {"value": float(latest["10 Yr"]), "date": date.isoformat(), "source": "treasury"}
    except Exception as error:  # noqa: BLE001
        log(f"[treasury] 官方源失败，改用 FRED：{error}")
        return fetch_fred("DGS10")


def fetch_fred(series_id):
    """圣路易斯联储 FRED 公开 CSV，无需密钥；油价通常滞后几个交易日。"""
    # 只取最近 45 天，避免下载几十年的全部历史（在 GitHub Actions 上会超时）
    start = (datetime.now(BEIJING) - timedelta(days=45)).strftime("%Y-%m-%d")
    text = http_get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}&cosd={start}", timeout=40)
    rows = [r for r in csv.reader(io.StringIO(text))][1:]
    rows = [r for r in rows if len(r) == 2 and r[1] not in ("", ".")]
    date, value = rows[-1]
    return {"value": float(value), "date": date, "source": "fred"}


def fetch_cny_midpoint():
    """中国外汇交易中心人民币中间价（待验证接口与字段）。"""
    url = "https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/fx/ccpr.json"
    payload = json.loads(http_get(url, referer="https://www.chinamoney.com.cn/"))
    records = payload.get("records") or []
    # lastDate 形如 "2026-09-30 9:15"，只取日期
    result = {"date": str((payload.get("data") or {}).get("lastDate", "")).split(" ")[0]}
    for record in records:
        pair = record.get("vrtEName") or record.get("vrtName") or ""
        if pair in ("USD/CNY", "美元/人民币"):
            result["usd"] = float(record["price"])
        if pair in ("HKD/CNY", "港元/人民币"):
            result["hkd"] = float(record["price"])
    return result


# ---------------------------------------------------------------- 工具
def fmt_num(value, digits=2):
    return f"{value:,.{digits}f}"


def fmt_pct(pct):
    return f"{pct:+.2f}%"


def tone(pct):
    return "up" if pct > 0 else "down" if pct < 0 else "flat"


def parse_num(text):
    try:
        return float("".join(ch for ch in str(text) if ch.isdigit() or ch in ".-"))
    except ValueError:
        return None


def sane(old_text, new_value, kind):
    old = parse_num(old_text)
    if old is None or old == 0:
        return True
    if kind == "yield_pt":
        return abs(new_value - old) <= SANITY[kind]
    return abs(new_value / old - 1) <= SANITY[kind]


def find_metric(market, label):
    return next((m for m in market["metrics"] if m["label"] == label), None)


def set_metric(market, label, value_text, change_text, metric_tone, kind, new_value, note=None):
    metric = find_metric(market, label)
    if not metric:
        return False
    if metric["value"] == value_text and metric.get("change") == change_text and (not note or metric.get("note") == note):
        return False  # 休市日数据没变，不算更新
    if not sane(metric["value"], new_value, kind):
        log(f"[跳过] {label}: 旧值 {metric['value']} → 新值 {value_text} 变化过大，疑似数据错误")
        return False
    metric.update({"value": value_text, "change": change_text, "tone": metric_tone})
    if note:
        metric["note"] = note
    return True


def set_headline(market, value_text, change_text, headline_tone, as_of):
    market["headline"].update({"value": value_text, "change": change_text, "tone": headline_tone, "asOf": as_of})


# ---------------------------------------------------------------- 免费文字说明
# 不调用 API，按当天数字用模板拼出每个市场的 summary，保证文字和数字不矛盾。
# 如果配置了 ANTHROPIC_API_KEY，update_commentary.py 随后会用更丰富的解读覆盖它。
EVERGREEN_SIGNALS = {
    "a-share": [
        {"title": "别只看一个指数", "body": "沪深 300、上证指数和深证成指覆盖的公司不同，涨跌经常不一致，判断整个市场要多看几个。"},
        {"title": "成交额看热度", "body": "成交额反映交易活跃程度。上涨如果缺少持续成交配合，持续性通常较弱，但这不是买卖信号。"},
        {"title": "单日波动很常见", "body": "A 股单日涨跌 1%～2% 很常见，长期配置更应关注估值、盈利和自己能承受多大回撤。"},
    ],
    "hong-kong": [
        {"title": "科技波动更大", "body": "恒生科技指数集中在互联网和科技公司，涨跌幅通常大于恒生指数，对海外利率和情绪更敏感。"},
        {"title": "双重定价", "body": "港股既反映中国企业基本面，也受美元利率、离岸流动性和风险偏好影响。"},
        {"title": "人民币投资体验", "body": "通过港股通投资时以人民币结算，但底层资产仍受港元及全球定价环境影响。"},
    ],
}


def describe_move(change_text):
    pct = parse_num(change_text)
    if pct is None:
        return ""
    if abs(pct) < 0.005:
        return "基本持平"
    return f"{'上涨' if pct > 0 else '下跌'} {abs(pct):.2f}%"


def metric_value(market, label):
    metric = find_metric(market, label)
    return metric["value"] if metric else ""


def metric_change(market, label):
    metric = find_metric(market, label)
    return metric.get("change", "") if metric else ""


def refresh_summaries(markets):
    a_share = markets["a-share"]
    date = a_share["headline"]["asOf"].split(" ")[0]
    pcts = [parse_num(metric_change(a_share, label)) or 0 for label in ("沪深 300", "上证指数", "深证成指")]
    mixed = max(pcts) > 0 > min(pcts)
    a_share["summary"] = (
        f"最近交易日（{date}）沪深 300 收于 {metric_value(a_share, '沪深 300')}，{describe_move(metric_change(a_share, '沪深 300'))}；"
        f"上证指数{describe_move(metric_change(a_share, '上证指数'))}，深证成指{describe_move(metric_change(a_share, '深证成指'))}，"
        f"沪深两市成交额约 {metric_value(a_share, '沪深成交额')}。"
        + ("几个主要指数涨跌不一，说明市场内部有分化。" if mixed else "")
        + "单日涨跌属于正常波动，不应据此改变长期配置比例。"
    )
    a_share["signals"] = EVERGREEN_SIGNALS["a-share"]

    hk = markets["hong-kong"]
    date = hk["headline"]["asOf"].split(" ")[0]
    gap = abs((parse_num(metric_change(hk, "恒生科技")) or 0) - (parse_num(metric_change(hk, "恒生指数")) or 0))
    hk["summary"] = (
        f"最近交易日（{date}）恒生指数{describe_move(metric_change(hk, '恒生指数'))}，"
        f"国企指数{describe_move(metric_change(hk, '国企指数'))}，恒生科技指数{describe_move(metric_change(hk, '恒生科技'))}。"
        + ("科技指数和恒指的涨跌幅差距较大，成长类公司对利率和情绪更敏感。" if gap >= 1 else "科技指数与恒指走势接近。")
        + "港股同时受内地基本面和海外利率影响，单日变化不宜过度解读。"
    )
    hk["signals"] = EVERGREEN_SIGNALS["hong-kong"]

    fx = markets["fx"]
    today, previous = parse_num(metric_value(fx, "今日中间价")), parse_num(metric_value(fx, "前一日中间价"))
    if today and previous:
        bp = round((today - previous) * 10000)
        move = "与前一日持平" if bp == 0 else f"较前一日人民币{'贬值' if bp > 0 else '升值'} {abs(bp)} 基点"
        fx["summary"] = (
            f"{fx['headline']['asOf'].split(' ')[0]} 人民币兑美元中间价为 {today:.4f}，{move}。"
            "人民币走强会压低未对冲美元资产折算成人民币后的收益；人民币走弱时则可能放大人民币计价收益。"
        )

    risk = markets["global-risk"]
    ust = parse_num(metric_value(risk, "美国 10 年期收益率"))
    brent = parse_num(metric_value(risk, "Brent 原油"))
    if ust and brent:
        rate_view = ("长端利率处在偏高位置，会压缩高估值资产的估值空间" if ust >= 4.5
                     else "长端利率处在偏低位置，对高估值资产的压力相对较小" if ust < 3 else "长端利率处在中等位置")
        oil_view = ("油价偏高，可能推升通胀与企业成本" if brent >= 90
                    else "油价偏低，通胀压力相对缓和" if brent < 60 else "油价处在中等区间")
        risk["summary"] = (
            f"美国 10 年期国债收益率最新为 {ust:.2f}%（{risk['headline']['asOf']}），"
            f"Brent 原油约 {metric_value(risk, 'Brent 原油')}、WTI 约 {metric_value(risk, 'WTI 原油')}（油价数据通常滞后几天）。"
            f"{rate_view}；{oil_view}。这些是对风险环境的观察，不是涨跌预测。"
        )


# ---------------------------------------------------------------- 主流程
def main():
    check_only = "--check" in sys.argv
    now = datetime.now(BEIJING)
    data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    markets = {m["id"]: m for m in data["markets"]}
    changed = []

    # A 股与港股
    try:
        quotes = fetch_index_quotes()
        if not quotes:
            raise RuntimeError("腾讯和东方财富都没有返回数据")

        def stamp(key):
            return f"{quotes[key].get('date') or now.strftime('%Y-%m-%d')} 收盘"

        a_share, hk = markets["a-share"], markets["hong-kong"]
        for key, label in (("csi300", "沪深 300"), ("sse", "上证指数"), ("szse", "深证成指")):
            q = quotes.get(key)
            if q and set_metric(a_share, label, fmt_num(q["value"]), fmt_pct(q["pct"]), tone(q["pct"]), "index", q["value"]):
                changed.append(label)
        if "csi300" in quotes and "沪深 300" in changed:
            q = quotes["csi300"]
            set_headline(a_share, fmt_num(q["value"]), fmt_pct(q["pct"]), tone(q["pct"]), stamp("csi300"))
        if changed and quotes.get("sse") and quotes.get("szse"):
            total = (quotes["sse"]["amount"] + quotes["szse"]["amount"]) / 1e12
            if total > 0:
                metric = find_metric(a_share, "沪深成交额")
                if metric:
                    metric.update({"value": f"{total:.3f} 万亿元", "change": "当日口径", "tone": "flat"})
                    changed.append("沪深成交额")
        for key, label in (("hstech", "恒生科技"), ("hsi", "恒生指数"), ("hscei", "国企指数")):
            q = quotes.get(key)
            if q and set_metric(hk, label, fmt_num(q["value"]), fmt_pct(q["pct"]), tone(q["pct"]), "index", q["value"]):
                changed.append(label)
        if "恒生科技" in changed:
            q = quotes["hstech"]
            set_headline(hk, fmt_num(q["value"]), fmt_pct(q["pct"]), tone(q["pct"]), stamp("hstech"))
    except Exception as error:  # noqa: BLE001
        log(f"[指数行情] 失败，A 股和港股保留旧值：{error}")

    # 人民币中间价
    try:
        fx = fetch_cny_midpoint()
        log(f"[cfets] {fx}")
        market = markets["fx"]
        if "usd" in fx:
            today_metric = find_metric(market, "今日中间价")
            previous = parse_num(today_metric["value"]) if today_metric else None
            if previous and sane(previous, fx["usd"], "fx") and abs(fx["usd"] - previous) > 1e-9:
                bp = round((fx["usd"] - previous) * 10000)
                direction = f"人民币贬值 {abs(bp)} 基点" if bp > 0 else f"人民币升值 {abs(bp)} 基点"
                prev_metric = find_metric(market, "前一日中间价")
                if prev_metric:
                    prev_metric.update({"value": f"{previous:.4f}", "change": f"变化 {fx['usd'] - previous:+.4f}",
                                        "tone": "down" if bp > 0 else "up", "note": direction.replace("人民币", "人民币较前日")})
                today_metric.update({"value": f"{fx['usd']:.4f}"})
                as_of = f"{fx.get('date') or now.strftime('%Y-%m-%d')} 09:15"
                set_headline(market, f"{fx['usd']:.4f}", direction, "down" if bp > 0 else "up", as_of)
                changed.append("人民币中间价")
        if "hkd" in fx:
            metric = find_metric(market, "100 港元")
            hkd_text = f"{fx['hkd'] * 100:.3f} 元人民币"
            if metric and metric["value"] != hkd_text:
                metric["value"] = hkd_text
                changed.append("港元中间价")
    except Exception as error:  # noqa: BLE001
        log(f"[cfets] 失败，汇率保留旧值：{error}")

    # 美债与油价
    market = markets["global-risk"]
    try:
        ust = fetch_treasury_10y(now)
        log(f"[ust10y] {ust}")
        if set_metric(market, "美国 10 年期收益率", f"{ust['value']:.2f}%", "官方最近可得", "risk", "yield_pt", ust["value"],
                      note=f"美国财政部 {ust['date']} 数据" if ust["source"] == "treasury" else f"FRED {ust['date']} 数据"):
            set_headline(market, f"{ust['value']:.2f}%", "最新官方可得值", "risk", ust["date"])
            changed.append("美债 10 年")
    except Exception as error:  # noqa: BLE001
        log(f"[ust10y] 失败：{error}")
    for series, label in (("DCOILBRENTEU", "Brent 原油"), ("DCOILWTICO", "WTI 原油")):
        try:
            oil = fetch_fred(series)
            log(f"[{series}] {oil}")
            if set_metric(market, label, f"${oil['value']:.2f} / 桶", "FRED 最近可得", "risk", "oil", oil["value"],
                          note=f"{oil['date']} 现货价，通常滞后数个交易日"):
                changed.append(label)
        except Exception as error:  # noqa: BLE001
            log(f"[{series}] 失败：{error}")
    # 旧版的「Brent 12 月合约」快照无法自动更新，删除以免过期
    market["metrics"] = [m for m in market["metrics"] if m["label"] != "Brent 12 月合约"]

    if not changed:
        log("没有任何数据更新（可能是休市日或数据源全部失败），不写文件。")
        return 0
    refresh_summaries(markets)
    data.pop("commentaryUpdatedAt", None)  # 文字已是按今天数字生成的模板，旧的“解读更新于”日期不再适用
    data["updatedAt"] = f"{now:%Y-%m-%d %H:%M}"
    data["timezone"] = "北京时间"
    if check_only:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        log(f"[--check] 将更新：{'、'.join(changed)}（未写入文件）")
        return 0
    DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    log(f"已更新：{'、'.join(changed)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
