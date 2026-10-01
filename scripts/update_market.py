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
  * 组合页当日涨跌估算：6 只境内 ETF（腾讯行情），写入 data/daily-moves.json。
    用境内 ETF 而不是海外指数：它们和 A 股同一时间收盘、都用人民币计价，已包含汇率影响。
  * 原油：新浪财经国际期货近月合约 hf_OIL / hf_CL 为主；失败时用 FRED 现货价
    （FRED 在 GitHub Actions 上访问超时，现货价也通常滞后数个交易日）。
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
DAILY_MOVES_FILE = ROOT / "data" / "daily-moves.json"
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


# 新浪财经外盘期货：以逗号分隔，[0]=最新价 [6]=时间 [7]=昨结算 [12]=日期（北京时间）
SINA_OIL = {"Brent 原油": ("hf_OIL", "DCOILBRENTEU"), "WTI 原油": ("hf_CL", "DCOILWTICO")}


def fetch_sina_oil():
    codes = ",".join(code for code, _ in SINA_OIL.values())
    text = http_get(f"https://hq.sinajs.cn/list={codes}", referer="https://finance.sina.com.cn/", encoding="gbk")
    out = {}
    for line in text.splitlines():
        if "=" not in line:
            continue
        name, _, raw = line.partition("=")
        f = raw.strip().strip(';"').split(",")
        if len(f) < 13 or not f[0]:
            continue
        price, prev = float(f[0]), float(f[7] or 0)
        out[name.removeprefix("var hq_str_")] = {"value": price, "pct": (price / prev - 1) * 100 if prev else 0.0,
                                                  "date": f[12], "time": f[6][:5]}
    return out


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


def turnover_update(metric, new_yi, value_text, unit, note):
    """成交额卡片：新值 + 与前一交易日相比的变化（单位：亿）。"""
    old = parse_num(metric["value"])
    if old and "万亿" in metric["value"]:
        old *= 1e4
    change = f"较前一交易日 {new_yi - old:+,.0f} 亿{unit}" if old else "当日口径"
    return {"value": value_text, "change": change, "tone": "flat", "note": note}


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
# 不调用 API，按当天数字用模板拼出每个市场的 summary，只写客观事实，不做判断和预测；
# signals 换成不依赖当天行情的通用阅读提示，保证文字和数字不矛盾。
# 如果配置了 ANTHROPIC_API_KEY，update_commentary.py 随后会用它生成的内容覆盖这些模板文字。
EVERGREEN_SIGNALS = {
    "a-share": [
        {"title": "别只看一个指数", "body": "沪深 300、上证指数和深证成指覆盖的公司不同，涨跌经常不一致，了解整个市场要多看几个。"},
        {"title": "成交额看热度", "body": "成交额反映交易活跃程度，可以和指数涨跌放在一起看，但它本身不是买卖信号。"},
        {"title": "单日波动很常见", "body": "A 股单日涨跌 1%～2% 很常见，长期配置更应关注估值、盈利和自己能承受多大回撤。"},
    ],
    "hong-kong": [
        {"title": "科技波动更大", "body": "恒生科技指数集中在互联网和科技公司，涨跌幅通常大于恒生指数，对海外利率和情绪更敏感。"},
        {"title": "双重定价", "body": "港股既反映中国企业基本面，也受美元利率、离岸流动性和风险偏好影响。"},
        {"title": "人民币投资体验", "body": "通过港股通投资时以人民币结算，但底层资产仍受港元及全球定价环境影响。"},
    ],
    "fx": [
        {"title": "看清报价方向", "body": "USD/CNY 数值下降通常代表人民币升值；数值上升通常代表人民币贬值。"},
        {"title": "汇率影响总收益", "body": "海外资产本身上涨，不代表人民币投资者一定获得同样涨幅；资产价格与汇率会共同作用。"},
        {"title": "渠道可能处理不同", "body": "QDII 净值、港股通结算和银行换汇采用的时间与价格并不相同，需要以产品文件与交易平台为准。"},
    ],
    "global-risk": [
        {"title": "利率和估值", "body": "长期利率上升会提高股票和 REITs 的折现率，对高估值成长资产的影响通常更明显；利率下降时反之。"},
        {"title": "能源和通胀", "body": "油价变化会传导到运输、制造与生活成本，进而影响通胀和降息预期，也会影响进口能源国家的汇率。"},
        {"title": "风险变量不是方向预测", "body": "利率和油价描述的是风险环境，不能单独用来判断明天股市涨跌。"},
    ],
}


def describe_move(change_text):
    pct = parse_num(change_text)
    if pct is None:
        return ""
    if abs(pct) < 0.005:
        return "与前一交易日持平"
    return f"{'上涨' if pct > 0 else '下跌'} {abs(pct):.2f}%"


def metric_value(market, label):
    metric = find_metric(market, label)
    return metric["value"] if metric else ""


def metric_change(market, label):
    metric = find_metric(market, label)
    return metric.get("change", "") if metric else ""


def index_sentence(market, label, name=None):
    name = name or label
    return f"{name}{' ' if name[-1].isascii() else ''}报 {metric_value(market, label)} 点，{describe_move(metric_change(market, label))}"


def oil_sentence(market, label):
    metric = find_metric(market, label)
    if not metric:
        return ""
    if "%" in metric.get("change", ""):  # 新浪期货：时间写在卡片备注里，摘要不重复
        return f"{label}期货报 {metric['value']}，较前一日结算价{describe_move(metric['change'])}"
    return f"{label}现货报 {metric['value']}（{metric.get('note', '').split('，')[0]}）"


def refresh_summaries(markets, history=None):
    """summary 只写当天客观事实；signals 用按数据得出的观察（数据不足时用通用阅读提示补足）。"""
    observations, context = market_observations(markets, history or {})
    for market_id, signals in observations.items():
        markets[market_id]["signals"] = signals

    a_share = markets["a-share"]
    a_share["summary"] = (
        f"最近交易日（{a_share['headline']['asOf'].split(' ')[0]}）收盘："
        f"{index_sentence(a_share, '沪深 300')}；{index_sentence(a_share, '上证指数')}；{index_sentence(a_share, '深证成指')}。"
        f"沪深两市成交额 {metric_value(a_share, '沪深成交额')}"
        + (f"，{metric_change(a_share, '沪深成交额')}。" if metric_change(a_share, "沪深成交额").startswith("较") else "。")
    )

    hk = markets["hong-kong"]
    hk["summary"] = (
        f"最近交易日（{hk['headline']['asOf'].split(' ')[0]}）收盘："
        f"{index_sentence(hk, '恒生指数')}；{index_sentence(hk, '国企指数')}；{index_sentence(hk, '恒生科技', '恒生科技指数')}。"
        f"全日成交额 {metric_value(hk, '全日成交额')}"
        + (f"，{metric_change(hk, '全日成交额')}。" if metric_change(hk, "全日成交额").startswith("较") else "。")
    )

    fx = markets["fx"]
    today, previous = parse_num(metric_value(fx, "今日中间价")), parse_num(metric_value(fx, "前一日中间价"))
    if today and previous:
        bp = round((today - previous) * 10000)
        move = ("与前一日持平" if bp == 0 else
                f"较前一日 {previous:.4f} {'上调' if bp > 0 else '下调'} {abs(bp)} 基点，即人民币{'贬值' if bp > 0 else '升值'}")
        fx["summary"] = (
            f"{fx['headline']['asOf'].split(' ')[0]} 人民币兑美元中间价为 {today:.4f}，{move}。"
            f"100 港元的人民币中间价为 {metric_value(fx, '100 港元')}。"
        )

    risk = markets["global-risk"]
    ust = find_metric(risk, "美国 10 年期收益率")
    parts = []
    if ust:
        parts.append(f"美国 10 年期国债收益率为 {ust['value']}（{risk['headline']['asOf']}）")
    parts += [sentence for sentence in (oil_sentence(risk, "Brent 原油"), oil_sentence(risk, "WTI 原油")) if sentence]
    if parts:
        risk["summary"] = "；".join(parts) + "。"
    return context


# ---------------------------------------------------------------- 历史数据与按数据判断
# 每次运行时直接取最近一年的历史行情，不另存文件；哪个源失败，相关判断就跳过。
# 判断只依据数字（连续涨跌、近 20 个交易日累计变化、在近一年中的位置、成交额变化、指数是否同向），
# 不解释原因、不预测方向。
LOOKBACK = 20  # “近一个月”按 20 个交易日计算


def fetch_history():
    history = {}
    for key, code in TENCENT_CODES.items():  # 腾讯日线一次只能取一个代码
        try:
            payload = json.loads(http_get(f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={code},day,,,260,qfq"))
            rows = ((payload.get("data") or {}).get(code) or {}).get("day") or []
            history[key] = [(row[0], float(row[2])) for row in rows if len(row) > 2]
        except Exception as error:  # noqa: BLE001
            log(f"[history-{key}] 失败：{error}")
    try:
        end = datetime.now(BEIJING).date()
        start = end - timedelta(days=360)  # 接口只允许查询一年以内
        rows, page, pages = [], 1, 1
        while page <= min(pages, 10):  # 接口每页最多 40 条，一年约 7 页
            payload = json.loads(http_get(
                "https://www.chinamoney.com.cn/ags/ms/cm-u-bk-ccpr/CcprHisNew"
                f"?startDate={start}&endDate={end}&currency=USD/CNY&pageNum={page}&pageSize=40",
                referer="https://www.chinamoney.com.cn/"))
            rows += [(r["date"], float(r["values"][0])) for r in payload.get("records") or [] if r.get("values")]
            pages = int((payload.get("data") or {}).get("pageTotal") or 1)
            page += 1
            time.sleep(1)
        history["usdcny"] = sorted(set(rows))
    except Exception as error:  # noqa: BLE001
        log(f"[history-cfets] 失败：{error}")
    try:
        rows = []
        year = datetime.now(BEIJING).year
        for y in (year - 1, year):
            url = ("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/"
                   f"daily-treasury-rates.csv/{y}/all?type=daily_treasury_yield_curve"
                   f"&field_tdr_date_value={y}&page&_format=csv")
            for r in csv.DictReader(io.StringIO(http_get(url))):
                if r.get("10 Yr"):
                    rows.append((datetime.strptime(r["Date"], "%m/%d/%Y").date().isoformat(), float(r["10 Yr"])))
        history["ust10y"] = sorted(rows)[-260:]
    except Exception as error:  # noqa: BLE001
        log(f"[history-ust] 失败：{error}")
    for key, symbol in (("brent", "OIL"), ("wti", "CL")):
        try:
            text = http_get("https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/"
                            f"GlobalFuturesService.getGlobalFuturesDailyKLine?symbol={symbol}",
                            referer="https://finance.sina.com.cn/")
            rows = json.loads(text[text.index("(") + 1:text.rindex(")")])
            history[key] = [(r["date"], float(r["close"])) for r in rows][-260:]
        except Exception as error:  # noqa: BLE001
            log(f"[history-{key}] 失败：{error}")
    log("[history] " + "，".join(f"{k} {len(v)} 条" for k, v in history.items()))
    return history


def with_latest(series, date, value):
    """历史序列末尾换成（或补上）当天最新值。"""
    series = [row for row in (series or []) if row[0] < date]
    return series + [(date, value)] if value is not None else series


def streak(series):
    """末尾连续同方向变动的天数和方向（+1 上涨 / -1 下跌）。"""
    count, direction = 0, 0
    for (_, prev), (_, cur) in zip(reversed(series[:-1]), reversed(series[1:])):
        step = (cur > prev) - (cur < prev)
        if step == 0 or (direction and step != direction):
            break
        direction, count = step, count + 1
    return count, direction


def change_over(series, days=LOOKBACK):
    """较 days 个交易日前的变化：(起点日期, 起点值, 当前值)。"""
    if len(series) <= days:
        return None
    return series[-days - 1][0], series[-days - 1][1], series[-1][1]


def percentile(series):
    """当前值高于近一年多少比例的交易日（0-100）。"""
    if len(series) < 120:
        return None
    current = series[-1][1]
    past = [v for _, v in series[:-1]]
    return round(sum(v < current for v in past) / len(past) * 100)


def level_text(level):
    if level >= 100:
        return "为近一年最高"
    if level <= 0:
        return "为近一年最低"
    return f"高于近一年 {level}% 的交易日"


def avg_abs_move(series, days=LOOKBACK):
    moves = [abs(cur / prev - 1) * 100 for (_, prev), (_, cur) in zip(series[-days - 1:-1], series[-days:])]
    return sum(moves) / len(moves) if moves else None


def cn_date(date):
    _, month, day = str(date)[:10].split("-")
    return f"{int(month)} 月 {int(day)} 日"


def signal(title, body):
    return {"title": title, "body": body}


def index_observations(name, series, today_pct, tip_streak, tip_month, tip_level):
    """单个指数的按数据判断：波动幅度、连续涨跌、近 20 日累计、近一年位置。"""
    out = []
    avg = avg_abs_move(series[:-1]) if series else None
    if today_pct is not None and avg and abs(today_pct) >= 1.5 and abs(today_pct) >= 2 * avg:
        out.append(("big", signal("单日波动偏大", f"{name}{describe_move(f'{today_pct}%')}，约为近 20 个交易日平均波动幅度"
                                              f"（{avg:.2f}%）的 {abs(today_pct) / avg:.1f} 倍。{tip_streak}")))
    count, direction = streak(series)
    if count >= 3:
        start = series[-count - 1][1]
        out.append(("streak", signal(f"连续 {count} 日{'上涨' if direction > 0 else '下跌'}",
                                     f"{name}已连续 {count} 个交易日{'上涨' if direction > 0 else '下跌'}，"
                                     f"累计{describe_move(f'{(series[-1][1] / start - 1) * 100}%')}。{tip_streak}")))
    month = change_over(series)
    if month:
        date, start, cur = month
        pct = (cur / start - 1) * 100
        out.append(("month", signal(f"近 20 日{'上涨' if pct > 0 else '下跌'} {abs(pct):.1f}%",
                                    f"{name}较 20 个交易日前（{cn_date(date)}，{start:,.2f} 点）{describe_move(f'{pct}%')}。{tip_month}")))
    level = percentile(series)
    if level is not None and (level >= 80 or level <= 20):
        out.append(("level", signal(f"处于近一年{'较高' if level >= 80 else '较低'}位置",
                                    f"{name}当前点位{level_text(level)}。{tip_level}")))
    return out


def pick(candidates, order, fallback, count=3):
    by_kind = {}
    for kind, item in candidates:
        by_kind.setdefault(kind, item)
    chosen = [by_kind[kind] for kind in order if kind in by_kind][:count]
    for item in fallback:
        if len(chosen) >= count:
            break
        if all(item["title"] != c["title"] for c in chosen):
            chosen.append(dict(item))
    return chosen


def turnover_pct(metric):
    """从“1.438 万亿元 / 较前一交易日 +286 亿元”算出成交额变化百分比。"""
    if not metric or not metric.get("change", "").startswith("较"):
        return None
    value, diff = parse_num(metric["value"]), parse_num(metric["change"].split("日", 1)[1])
    if value is None or diff is None:
        return None
    value *= 1e4 if "万亿" in metric["value"] else 1
    return diff / (value - diff) * 100 if value - diff else None


def market_observations(markets, history):
    """返回 {market_id: [signal...]} 和组合页用的一句话。"""
    result, context = {}, []
    a_share, hk, fx, risk = markets["a-share"], markets["hong-kong"], markets["fx"], markets["global-risk"]

    # ---- A 股
    names = {"沪深 300": "csi300", "上证指数": "sse", "深证成指": "szse"}
    pcts = {label: parse_num(metric_change(a_share, label)) for label in names}
    date = a_share["headline"]["asOf"].split(" ")[0]
    csi = with_latest(history.get("csi300"), date, parse_num(metric_value(a_share, "沪深 300")))
    cands = index_observations("沪深 300 ", csi, pcts["沪深 300"],
                               "连续或单日的涨跌并不预示下一天的方向。",
                               "一个月内的涨跌在 A 股很常见，长期配置更看估值、盈利和自己能承受的回撤。",
                               "点位高低不等于贵或便宜，还要结合盈利和估值看。")
    ups = [k for k, v in pcts.items() if v and v > 0]
    downs = [k for k, v in pcts.items() if v and v < 0]
    if pcts and all(v is not None for v in pcts.values()):
        if len(ups) == 3 or len(downs) == 3:
            cands.append(("same", signal(f"三大指数同步{'上涨' if ups else '下跌'}",
                                         f"沪深 300、上证指数和深证成指同步{'上涨' if ups else '下跌'}，"
                                         f"涨跌幅在 {min(pcts.values()):+.2f}% 到 {max(pcts.values()):+.2f}% 之间。不同指数覆盖的公司不同，同向时说明大中小盘表现较一致。")))
        else:
            cands.append(("same", signal("主要指数涨跌不一",
                                         f"{'、'.join(ups) or '没有指数'}上涨，{'、'.join(downs) or '没有指数'}下跌。不同指数覆盖的公司不同，看整个市场要多看几个。")))
    turnover = turnover_pct(find_metric(a_share, "沪深成交额"))
    if turnover is not None and abs(turnover) >= 10:
        cands.append(("turnover", signal(f"成交额{'放大' if turnover > 0 else '缩小'} {abs(turnover):.0f}%",
                                         f"沪深两市成交额 {metric_value(a_share, '沪深成交额')}，较前一交易日{'增加' if turnover > 0 else '减少'} "
                                         f"{abs(turnover):.0f}%。成交额反映交易活跃程度，本身不是买卖信号。")))
    result["a-share"] = pick(cands, ("big", "streak", "turnover", "same", "month", "level"), EVERGREEN_SIGNALS["a-share"])
    month = change_over(csi)
    csi_month_pct = round((month[2] / month[1] - 1) * 100, 2) if month else None
    a_text = f"沪深 300 {metric_value(a_share, '沪深 300')}（{metric_change(a_share, '沪深 300')}）"
    if month:
        a_text += f"，近 20 个交易日{describe_move(f'{csi_month_pct}%')}"
    context.append(a_text)

    # ---- 港股
    date = hk["headline"]["asOf"].split(" ")[0]
    tech = with_latest(history.get("hstech"), date, parse_num(metric_value(hk, "恒生科技")))
    hsi = with_latest(history.get("hsi"), date, parse_num(metric_value(hk, "恒生指数")))
    tech_pct, hsi_pct = parse_num(metric_change(hk, "恒生科技")), parse_num(metric_change(hk, "恒生指数"))
    cands = index_observations("恒生科技指数", tech, tech_pct,
                               "连续或单日的涨跌并不预示下一天的方向。",
                               "科技指数的月度波动通常大于恒指，配置时要按更高的波动来预期。",
                               "点位高低不等于贵或便宜，还要结合盈利和估值看。")
    if tech_pct is not None and hsi_pct is not None and abs(tech_pct - hsi_pct) >= 1:
        cands.append(("gap", signal("科技与恒指差距较大",
                                    f"恒生科技指数{describe_move(f'{tech_pct}%')}，恒生指数{describe_move(f'{hsi_pct}%')}，"
                                    f"相差 {abs(tech_pct - hsi_pct):.2f} 个百分点。科技公司对海外利率和情绪更敏感。")))
    hsi_month, tech_month = change_over(hsi), change_over(tech)
    if hsi_month and tech_month:
        h, t = (hsi_month[2] / hsi_month[1] - 1) * 100, (tech_month[2] / tech_month[1] - 1) * 100
        cands.append(("month", signal("近 20 日对比",
                                      f"近 20 个交易日，恒生指数{describe_move(f'{h}%')}，恒生科技指数{describe_move(f'{t}%')}。"
                                      "科技指数的波动通常大于恒指，配置时要按更高的波动来预期。")))
    result["hong-kong"] = pick(cands, ("big", "streak", "gap", "month", "level"), EVERGREEN_SIGNALS["hong-kong"])

    # ---- 人民币
    today = parse_num(metric_value(fx, "今日中间价"))
    date = fx["headline"]["asOf"].split(" ")[0]
    usd = with_latest(history.get("usdcny"), date, today)
    cands = []
    count, direction = streak(usd)
    if count >= 3:
        bp = round((usd[-1][1] - usd[-count - 1][1]) * 10000)
        cands.append(("streak", signal(f"连续 {count} 日{'贬值' if direction > 0 else '升值'}",
                                       f"人民币中间价已连续 {count} 个交易日{'贬值' if direction > 0 else '升值'}，累计 {abs(bp)} 基点。"
                                       "USD/CNY 数值上升代表人民币贬值，下降代表升值。")))
    month = change_over(usd)
    fx_text = f"美元兑人民币中间价 {metric_value(fx, '今日中间价')}"
    if month:
        bp = round((month[2] - month[1]) * 10000)
        word = "贬值" if bp > 0 else "升值"
        cands.append(("month", signal(f"近 20 日{word} {abs(bp)} 基点" if bp else "近 20 日基本持平",
                                      f"中间价较 20 个交易日前（{cn_date(month[0])}，{month[1]:.4f}）"
                                      f"{'上调' if bp > 0 else '下调'} {abs(bp)} 基点。汇率变化会影响未对冲海外资产换算成人民币后的收益。")))
        if bp:
            fx_text += f"，近 20 个交易日人民币{word} {abs(bp)} 基点"
    level = percentile(usd)
    if level is not None and (level >= 80 or level <= 20):
        cands.append(("level", signal(f"人民币近一年{'偏弱' if level >= 80 else '偏强'}",
                                      f"当前美元兑人民币中间价{level_text(level)}；这个数值越低，代表人民币越强。汇率长期走势难以预测，海外资产比例不宜按汇率高低来调整。")))
    result["fx"] = pick(cands, ("streak", "month", "level"), EVERGREEN_SIGNALS["fx"])
    context.append(fx_text)

    # ---- 美债与油价
    cands = []
    ust_value = parse_num(metric_value(risk, "美国 10 年期收益率"))
    ust = with_latest(history.get("ust10y"), risk["headline"]["asOf"][:10], ust_value)
    ust_text = f"美国 10 年期国债收益率 {metric_value(risk, '美国 10 年期收益率')}"
    if len(ust) >= 2:
        day_bp = round((ust[-1][1] - ust[-2][1]) * 100)
        month = change_over(ust)
        body = f"10 年期美债收益率较前一交易日{'上升' if day_bp > 0 else '下降' if day_bp < 0 else '持平'}"
        body += f" {abs(day_bp)} 个基点" if day_bp else ""
        title = "美债收益率变化"
        if month:
            month_bp = round((month[2] - month[1]) * 100)
            body += f"，较 20 个交易日前（{month[1]:.2f}%）{'上升' if month_bp > 0 else '下降'} {abs(month_bp)} 个基点"
            title = f"美债收益率月{'升' if month_bp > 0 else '降'} {abs(month_bp)} 基点" if month_bp else "美债收益率月内持平"
            if month_bp:
                ust_text += f"，较一个月前{'上升' if month_bp > 0 else '下降'} {abs(month_bp)} 个基点"
        cands.append(("ust", signal(title, body + "。长期利率变化会影响股票、REITs 和债券的估值。")))
    level = percentile(ust)
    if level is not None and (level >= 80 or level <= 20):
        cands.append(("ust-level", signal(f"美债收益率近一年{'偏高' if level >= 80 else '偏低'}",
                                          f"当前 10 年期美债收益率{level_text(level)}。利率水平描述的是环境，不能单独用来判断股市涨跌。")))
    brent = history.get("brent") or []  # 新浪日线最后一行即当前交易日，与卡片上的最新价基本一致
    month = change_over(brent)
    if month:
        pct = (month[2] / month[1] - 1) * 100
        cands.append(("oil", signal(f"Brent 近 20 日{'上涨' if pct > 0 else '下跌'} {abs(pct):.1f}%",
                                    f"Brent 原油期货较 20 个交易日前（${month[1]:.2f}）{describe_move(f'{pct}%')}。"
                                    "油价变化会传导到运输、制造与生活成本，进而影响通胀和利率预期。")))
    level = percentile(brent)
    if level is not None and (level >= 80 or level <= 20):
        cands.append(("oil-level", signal(f"油价近一年{'偏高' if level >= 80 else '偏低'}",
                                          f"当前 Brent 原油价格{level_text(level)}。能源价格波动大，不能单独用来判断股市涨跌。")))
    result["global-risk"] = pick(cands, ("ust", "oil", "ust-level", "oil-level"), EVERGREEN_SIGNALS["global-risk"])
    context.append(ust_text)

    # 组合页“今天的行情会改变这个比例吗？”：数据句子 + 供页面对比用的近 20 日涨跌幅（理由部分由 app.js 结合用户答案生成）
    # marketContext 保持纯文字（旧版页面缓存也能正常显示），数字单独放在 marketContextCsi300Change20d
    return result, ("；".join(context) + "。", csi_month_pct)


# ---------------------------------------------------------------- 组合页：境内 ETF 当日涨跌
# 和 A 股同一时间收盘、人民币计价、已包含汇率影响，不用处理时差和换汇。
# 资产类别对应关系在 app.js（DAILY_IMPACT_MAP）：中国权益 = 70% 沪深300ETF + 30% 恒生ETF，现金按 0%。
DAILY_ETFS = [
    ("510300", "sh510300", "沪深300ETF"),
    ("159920", "sz159920", "恒生ETF"),
    ("511010", "sh511010", "国债ETF"),
    ("513500", "sh513500", "标普500ETF"),
    ("518880", "sh518880", "黄金ETF"),
    ("160140", "sz160140", "美国REIT"),
]
ETF_DAILY_LIMIT = 10.5  # 境内 ETF / LOF 单日涨跌幅限制为 10%，超过即判定数据异常


def fetch_etf_moves():
    text = http_get("https://qt.gtimg.cn/q=" + ",".join(code for _, code, _ in DAILY_ETFS), encoding="gbk")
    fields_by_code = {}
    for line in text.split(";"):
        if "=" in line:
            name, _, raw = line.strip().partition("=")
            fields_by_code[name.removeprefix("v_")] = raw.strip('"').split("~")
    out = {}
    for symbol, code, name in DAILY_ETFS:
        f = fields_by_code.get(code)
        if not f or len(f) < 33 or not f[3] or not f[4]:
            continue
        price, prev = float(f[3]), float(f[4])
        if price <= 0 or prev <= 0:
            continue
        digits = "".join(ch for ch in f[30] if ch.isdigit())[:8]
        out[symbol] = {"code": symbol, "name": name, "price": price, "prevClose": prev,
                       "changePct": round((price / prev - 1) * 100, 3),
                       "date": f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}"}
    return out


def update_daily_moves(now, check_only):
    """整份快照要么全部更新，要么保留上一个交易日：任一只缺失、异常或日期不一致都不写入。"""
    old = {}
    if DAILY_MOVES_FILE.exists():
        old = json.loads(DAILY_MOVES_FILE.read_text(encoding="utf-8"))
    old_by_code = {item["code"]: item for item in old.get("etfs", [])}
    try:
        moves = fetch_etf_moves()
    except Exception as error:  # noqa: BLE001
        log(f"[etf] 失败，保留上一个交易日的数据：{error}")
        return False
    log(f"[etf] {moves}")
    if len(moves) != len(DAILY_ETFS):
        log(f"[etf] 只取到 {len(moves)} 只，保留上一个交易日的数据")
        return False
    dates = {item["date"] for item in moves.values()}
    if len(dates) != 1:
        log(f"[etf] 交易日期不一致 {dates}，保留上一个交易日的数据")
        return False
    date = dates.pop()
    if old.get("date") and date <= old["date"]:
        log(f"[etf] 交易日 {date} 没有新数据（休市或尚未收盘），保留上一个交易日")
        return False
    for symbol, item in moves.items():
        previous = old_by_code.get(symbol)
        if abs(item["changePct"]) > ETF_DAILY_LIMIT or (previous and not sane(previous["price"], item["price"], "index")):
            log(f"[etf] {item['name']} 涨跌幅 {item['changePct']}% 或价格变化异常，整份不写入")
            return False
    snapshot = {
        "date": date,
        "updatedAt": f"{now:%Y-%m-%d %H:%M}",
        "timezone": "北京时间",
        "source": "腾讯行情：境内 ETF 收盘价与前收盘价",
        "etfs": [{k: v for k, v in moves[symbol].items() if k != "date"} for symbol, _, _ in DAILY_ETFS],
    }
    if check_only:
        log(f"[--check] daily-moves.json 将更新为 {date}（未写入文件）")
        return True
    DAILY_MOVES_FILE.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    log(f"已更新：组合页当日涨跌（{date}）")
    return True


# ---------------------------------------------------------------- 主流程
def main():
    check_only = "--check" in sys.argv
    update_daily_moves(datetime.now(BEIJING), check_only)  # 独立文件，和下面的行情是否变化无关
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
                    metric.update(turnover_update(metric, total * 1e4, f"{total:.3f} 万亿元", "元", "沪市与深市合计"))
                    changed.append("沪深成交额")
        for key, label in (("hstech", "恒生科技"), ("hsi", "恒生指数"), ("hscei", "国企指数")):
            q = quotes.get(key)
            if q and set_metric(hk, label, fmt_num(q["value"]), fmt_pct(q["pct"]), tone(q["pct"]), "index", q["value"]):
                changed.append(label)
        hk_changed = any(label in changed for label in ("恒生科技", "恒生指数", "国企指数"))
        if hk_changed and quotes.get("hsi", {}).get("amount"):
            amount = quotes["hsi"]["amount"] / 1e8
            metric = find_metric(hk, "全日成交额")
            if metric:
                metric.update(turnover_update(metric, amount, f"{amount:,.2f} 亿港元", "港元", "不同数据商统计口径可能有差异"))
                changed.append("港股成交额")
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
    try:
        sina_oil = fetch_sina_oil()
        log(f"[sina-oil] {sina_oil}")
    except Exception as error:  # noqa: BLE001
        sina_oil = {}
        log(f"[sina-oil] 失败，改用 FRED：{error}")
    for label, (code, series) in SINA_OIL.items():
        try:
            if code in sina_oil:
                oil = sina_oil[code]
                ok = set_metric(market, label, f"${oil['value']:.2f} / 桶", fmt_pct(oil["pct"]), "risk", "oil", oil["value"],
                                note=f"国际期货近月合约，北京时间 {oil['date']} {oil['time']}")
            else:
                oil = fetch_fred(series)
                log(f"[{series}] {oil}")
                ok = set_metric(market, label, f"${oil['value']:.2f} / 桶", "FRED 最近可得", "risk", "oil", oil["value"],
                                note=f"{oil['date']} 现货价，通常滞后数个交易日")
            if ok:
                changed.append(label)
        except Exception as error:  # noqa: BLE001
            log(f"[{label}] 失败：{error}")
    # 旧版的「Brent 12 月合约」快照无法自动更新，删除以免过期
    market["metrics"] = [m for m in market["metrics"] if m["label"] != "Brent 12 月合约"]

    if not changed:
        log("没有任何数据更新（可能是休市日或数据源全部失败），不写文件。")
        return 0
    data["marketContext"], data["marketContextCsi300Change20d"] = refresh_summaries(markets, fetch_history())
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
