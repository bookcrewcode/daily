# Data + Model Plumbing Brief: Paper-Trading System (Supabase Edge Functions + Next.js PWA)

**Date verified:** 2026-09-07 (evening ET; US markets closed for Labor Day, so equity "last" values are Fri 2026-09-04).
**How verified:** every endpoint below was hit with `curl` from a residential Mac IP (browser User-Agent unless noted), and the important ones were re-fetched through a server-side fetcher running on datacenter IPs (column "DC"). Response bodies are saved under the scratchpad `curl/` folder. Statuses are what came back, not what docs promise.

## 0. Verified endpoints table

| Endpoint (GET unless noted) | Residential curl | DC fetch | CORS header |
|---|---|---|---|
| Yahoo `query1|query2.finance.yahoo.com/v8/finance/chart/AAPL?range=1mo&interval=1d` (also `5d/5m`, `range=max`, `BTC-USD/1h`) | **429** "Too Many Requests" on every call, incl. cookie+crumb flow (`v1/test/getcrumb` itself 429) | **200** JSON: daily and 5-min bars, `validRanges` `1d..max` | none |
| Yahoo `v7/finance/quote?symbols=AAPL` | 429 | – | none |
| Stooq `stooq.com/q/d/l/?s=aapl.us&i=d` (also `stooq.pl`, `spy.us`, `btc.v`) | 200 but body is a **JavaScript proof-of-work challenge page**, no CSV; `/q/l/` quote URL 404 | empty | none |
| Finnhub `/quote`, `/stock/candle`, `/calendar/earnings`, `/calendar/economic`, `/news` (no key) | 401 `{"error":"Please use an API key."}` | – | `*` |
| Twelve Data `time_series` (1day, 5min, BTC/USD, outputsize=5000), `quote`, `price` with `apikey=demo` | 200 | 200 | `*` |
| Alpha Vantage `TIME_SERIES_DAILY`, `GLOBAL_QUOTE`, `TIME_SERIES_INTRADAY` (`apikey=demo`, IBM) | 200 | – | `*` |
| Polygon/Massive `api.polygon.io` and `api.massive.com` `/v2/aggs/...` (no key) | 401 "API Key was not provided" | – | reflects `Origin` |
| Tiingo `/tiingo/daily/aapl/prices`, `/iex/?tickers=aapl` (no key) | 403 "Please supply a token" | – | none |
| EODHD `/api/eod`, `/api/real-time`, `/api/intraday?interval=5m` (`api_token=demo`) | 200 (intraday: 6,399 five-minute bars back to 2026-05-12) | – | none |
| FMP `/stable/quote`, `/api/v3/quote` (no key) | 401 "Invalid API KEY" | – | `*` |
| Nasdaq Data Link `datasets/WIKI/AAPL.json` | 403 Incapsula bot challenge | – | none |
| marketstack `/v2/eod`, `/v1/eod` (no key) | 401 `missing_access_key` | – | `*` |
| CoinGecko `/simple/price`, `/coins/bitcoin/market_chart?days=30|1`, `/coins/bitcoin/ohlc?days=30` (no key) | 200; `days=max` → **401 error 10012** (365-day cap); 6th rapid call → **429 Retry-After: 60** | **429 Retry-After: 12** | `*` |
| Binance `api.binance.com/api/v3/klines` | **451** "restricted location" | 451 | none |
| Binance `data-api.binance.vision/api/v3/klines` | 200 (+`x-mbx-used-weight-1m`) | 200 | `*` |
| Binance.US `api.binance.us/api/v3/klines?symbol=BTCUSD` | 200 | – | `*` |
| Coinbase Exchange `api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400|3600`, `/ticker`; `start/end` back to 2020 | 200 (350 rows default; 153 rows for the 2020 window) | 200 | `*` |
| Coinbase `api.coinbase.com/v2/prices/BTC-USD/spot` | 200 | – | `*` |
| Kraken `/0/public/OHLC?pair=XBTUSD&interval=1440|60`, `/0/public/Ticker` | 200 (721 rows; `since=2020` still returns the newest 721) | 200 | reflects `Origin` |
| CryptoCompare `min-api.cryptocompare.com/data/v2/histoday|histohour`, `pricemultifull` | 401 "API key required" | – | none |
| FRED `api.stlouisfed.org/fred/series/observations`, `/fred/releases/dates` (no key) | 400 "Variable api_key is not set" | – | none |
| FRED `fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL` (keyless) | stalls / HTTP2 INTERNAL_ERROR, 0 bytes | **200** CSV, 948 rows 1947-01..2026-07 | none |
| BLS `api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SA0?latest=true` and POST multi-series (no key) | 200 `REQUEST_SUCCEEDED` | – | `*` |
| BLS schedule HTML `bls.gov/schedule/news_release/cpi.htm`, `empsit.htm` | **403** Akamai "Access Denied" (any UA) | **200** (dates parsed below) | none |
| Fed `federalreserve.gov/monetarypolicy/fomccalendars.htm`; `feeds/press_monetary.xml` | 200 / 200 | 200 | none |
| Trading Economics `api.tradingeconomics.com/calendar?c=guest:guest` | **410** "the guest account has been discontinued" | – | none |
| Nasdaq `api.nasdaq.com/api/calendar/earnings?date=`, `/calendar/economicevents?date=`, `/quote/AAPL/info|chart|historical` | 200 with browser UA + `Accept`/`Accept-Language`; curl UA → connection reset | **timeout ×2 (60 s)** | none |
| Yahoo `finance.yahoo.com/calendar/earnings` | 200, HTML only | – | – |
| OpenRouter `GET /api/v1/models` / `OPTIONS` | 200 (428 models, 704 KB) / 204 | – | `*` |
| OpenRouter `GET /api/v1/models/anthropic/claude-sonnet-4.5/endpoints` | 200 (per-provider pricing/params/uptime, no key) | – | `*` |
| OpenRouter `GET /api/v1/key`, `/api/v1/auth/key`, `/api/v1/credits`, `/api/v1/generation?id=` (no key / bad key) | 401 "No cookie auth credentials found" / 401 "User not found." | – | `*` |
| OpenRouter `POST /api/v1/chat/completions` (no key / bad key) | 401 / 401 | – | `*` |

**Datacenter caveat that matters for you:** Supabase Edge Functions have no static egress IPs (Supabase's own troubleshooting doc says so), and Cloudflare/Akamai-fronted sites sometimes challenge datacenter traffic. Keyed APIs built for servers (Finnhub, Tiingo, Twelve Data, Massive, FRED, BLS, CoinGecko-with-key, OpenRouter) are safe. The fragile ones are exactly the "free-because-unofficial" ones: Yahoo (shared-IP 429s), Nasdaq (timed out from the datacenter twice), Stooq (JS challenge), BLS HTML pages (Akamai).

## Part A: Market data

### A1. US stocks/ETFs, candidate by candidate

**Yahoo Finance v8 chart (unofficial).** No key. Works without a crumb; `v7/quote` needs the cookie+crumb dance. Real-time-ish `meta.regularMarketPrice`, intraday `1m/5m/15m/60m`, history to `range=max` (decades). Rate limits undocumented; from this Mac every request (even the crumb fetch) is 429'd right now, most likely because other bots on this network hammer yfinance, while the datacenter fetch succeeded with both daily and 5-minute bars. No CORS (server only). Terms: Yahoo's ToS forbids automated access; endpoints change without notice. Verdict: excellent shape, unreliable supply; use as an opportunistic tertiary with backoff, never as the source of record.
Response shape: `chart.result[0].meta{symbol,regularMarketPrice,regularMarketTime,dataGranularity,validRanges}`, `chart.result[0].timestamp[]`, `chart.result[0].indicators.quote[0]{open[],high[],low[],close[],volume[]}`, `indicators.adjclose[0].adjclose[]` for daily.

**Stooq CSV.** Dead for programmatic use as of Sept 2026: both `stooq.com` and `stooq.pl` return an HTML page that runs a `crypto.subtle` hash proof-of-work before serving the CSV; third-party notes say a CAPTCHA-issued key is now required. Drop it.

**Finnhub (free key).** 60 calls/min, "Personal Use" license (pricing page). `/quote` is free and real-time for US (`c,d,dp,h,l,o,pc,t`). `/stock/candle` is **premium-only**: the pricing page marks OHLC/tick data premium and GitHub issue #546 (Apr 2025) shows the free key getting 403 "You don't have access to this resource" for AAPL daily candles. `/calendar/earnings` is free (1-month window, US). `/calendar/economic` is part of the separately-priced economic-data product, not the free plan. `/news` (general + company) is free. CORS `*` (but never ship the key to the browser). Verdict: primary for **quotes, earnings calendar, news**; useless for history.

**Twelve Data (free key).** 800 credits/day, 8/min; `apikey=demo` verified for AAPL and BTC/USD. `time_series` intervals `1min..1month`, `outputsize` up to 5000 per call (one call returned AAPL daily bars back to 2006-10-19), `quote`, `price`. Real-time US equities are sourced from venues that "represent approximately 5% of total US trading volume" (their own support article), so closes can differ slightly from consolidated prints. Crypto pairs are Binance-sourced. License: "Internal non-display usage." CORS `*`. Verdict: best all-round fallback (stocks + crypto + intraday in one key).
Shape: `{"meta":{"symbol","interval","currency","exchange","mic_code","type"},"values":[{"datetime","open","high","low","close","volume"}],"status":"ok"}`; `quote` adds `previous_close, change, percent_change, is_market_open, fifty_two_week{}`.

**Alpha Vantage (free key).** 25 requests/day, 5/min. `TIME_SERIES_DAILY` (`outputsize=compact` = 100 rows, `full` = 20+ years), `GLOBAL_QUOTE`, `TIME_SERIES_INTRADAY` (5-min bars returned; intraday is delayed unless you buy the realtime entitlement). CORS `*`. Verdict: 25/day is too few for a watchlist; emergency fallback only.

**Polygon.io, now "Massive".** `polygon.io/pricing` 301-redirects to `massive.com/pricing`; both `api.polygon.io` and `api.massive.com` answer identically. Stocks Basic ($0): 5 calls/min, **end-of-day** data, 2 years of history, minute aggregates included, "individual use only"; Starter $29/mo: unlimited calls, 15-min delayed, 5 years. CORS: reflects the request origin (browser-usable, key in query string). Verdict: cleanest EOD OHLCV JSON; 5/min means a 20-ticker watchlist takes 4 minutes per refresh.
Shape: `GET /v2/aggs/ticker/{T}/range/1/day/{from}/{to}?adjusted=true&sort=asc&apiKey=` → `{"results":[{"t":ms,"o","h","l","c","v","vw","n"}],"resultsCount","status":"OK"}`.

**Tiingo (free key).** 50 requests/hour, 1,000/day, 500 unique symbols/month, 1 GB/month; EOD "Composite Prices" with 30+ years of split/dividend-adjusted history; IEX feed (real-time/intraday) and crypto included; "Internal Use Only". No CORS (server only). Verdict: **primary for daily history**.
Shape: `GET /tiingo/daily/{ticker}/prices?startDate=YYYY-MM-DD&token=` → `[{"date","open","high","low","close","volume","adjOpen","adjHigh","adjLow","adjClose","adjVolume","divCash","splitFactor"}]`; intraday `GET /iex/{ticker}/prices?resampleFreq=5min&token=`.

**EODHD (free key).** 20 calls/day (EOD and real-time cost 1 call each, intraday costs 5), 1 year of EOD history on the free plan, 1,000 req/min cap. Demo token verified (EOD, delayed "real-time", 5-min intraday). No CORS. Verdict: too thin; skip unless you buy it.

**Financial Modeling Prep (free key).** 250 calls/day, **US-only**, end-of-day, 5 years of price history, ~500 MB/30 days, Stable API only (legacy `/api/v3` is discontinued for free accounts). CORS `*`. Verdict: decent EOD/quote fallback.

**Nasdaq Data Link.** No free US equity price dataset since WIKI ended (2018); anonymous 50 calls/day; site fronted by Incapsula. Not useful here. **marketstack:** free = 100 requests/month, EOD only. Not useful.

### A2. Crypto

**CoinGecko.** Keyless public API works but is IP-shared: 5 rapid calls succeeded, the 6th got 429 (`Retry-After: 60`) and the datacenter fetch got 429 immediately. Get the free **Demo key** (`x-cg-demo-api-key` header; 100 calls/min, 10,000 credits/month, attribution required). Public/Demo history is capped at **365 days** (error 10012). `market_chart` granularity is automatic (5-min for `days=1`, hourly for 2–90, daily beyond); `/ohlc` gives 4-hour candles for `days=30`. CORS `*`. Verdict: coin universe, market caps, 24h/7d changes; not your candle source.
Shapes: `/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true` → `{"bitcoin":{"usd":78967,"usd_24h_change":-1.37,"last_updated_at":1788836150}}`; `/coins/bitcoin/market_chart?vs_currency=usd&days=30&interval=daily` → `{"prices":[[ms,price]],"market_caps":[],"total_volumes":[]}`.

**Coinbase Exchange (public, no key).** `GET /products/BTC-USD/candles?granularity=86400` (allowed: 60, 300, 900, 3600, 21600, 86400); docs cap 300 candles per request (we got 350 by default); paginate with `start`/`end` ISO timestamps, years of history (2020 verified). Public limit 10 req/s per IP. CORS `*`. Rows are newest-first: `[time, low, high, open, close, volume]`. Verdict: **primary crypto candles**.

**Kraken (public, no key).** `GET /0/public/OHLC?pair=XBTUSD&interval=1440` (intervals 1, 5, 15, 30, 60, 240, 1440, 10080, 21600) returns **up to 720 most recent** candles, older data unobtainable regardless of `since` (docs; verified: 721 daily rows from 2024-09-18). Public ~1 req/s per IP. CORS reflects origin. Row: `[time, open, high, low, close, vwap, volume, count]` inside `result.XXBTZUSD`. Verdict: fallback candles + `Ticker` for spot.

**Binance.** `api.binance.com` returns 451 from US residential and datacenter IPs. `data-api.binance.vision` (market-data-only host) returned klines from both vantages with `x-mbx-used-weight` headers; `api.binance.us` works for `BTCUSD`. Geo policy can change without notice; tertiary only. Kline row: `[openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBuyBase, takerBuyQuote, ignore]`.

**CryptoCompare.** Free tier retired 2026-05-21 (CoinDesk Data announcement); every call now 401 "API key required." Drop.

### A3. Economic data and calendars

**FRED (free key, 120 req/min).** `GET /fred/series/observations?series_id=CPIAUCSL&api_key=&file_type=json&sort_order=desc&limit=3` → `{"observations":[{"date","value"}]}`. For upcoming release dates use `GET /fred/releases/dates?api_key=&file_type=json&include_release_dates_with_no_data=true&realtime_start=2026-09-07` → `{"release_dates":[{"release_id":10,"release_name":"Consumer Price Index","date":"2026-09-11"}]}` (the `include_release_dates_with_no_data=true` flag is what surfaces future dates). Common ids: 10 CPI, 50 Employment Situation, 46 PPI, 53 GDP, 54 Personal Income and Outlays; confirm via `/fred/releases`. The keyless `fredgraph.csv` works from the datacenter but stalled from residential; treat as a bonus, not a dependency.

**BLS API v2.** No key: 25 queries/day, 25 series/query, 10 years; free registration key: 500/day, 50 series, 20 years, plus net/percent changes. POST `{"seriesid":["CUUR0000SA0","LNS14000000","CES0000000001"],"startyear":"2026","endyear":"2026","registrationkey":"..."}` → verified: CPI-U Jul-2026 333.918, unemployment Aug-2026 4.1%, payrolls Aug-2026 159,075K. CORS `*`.

**Release calendar (verified dates):**
- CPI (BLS, 08:30 ET): Sep 11 (Aug data), Oct 14, Nov 10, Dec 10, 2026.
- Employment Situation / NFP (08:30 ET): Sep 4 (done), Oct 2, Nov 6, Dec 4, 2026.
- FOMC 2026: Jan 27-28, Mar 17-18*, Apr 28-29, Jun 16-17*, Jul 28-29, **Sep 15-16***, Oct 27-28, Dec 8-9* (*with projections). 2027 tentative: Jan 26-27, Mar 16-17*, Apr 27-28, Jun 8-9*, Jul 27-28, Sep 14-15*, Oct 26-27, Dec 7-8*. Fed statements arrive on the `press_monetary.xml` RSS.
BLS schedule pages are blocked to plain curl (Akamai) but loaded from the datacenter fetcher, so Deno `fetch` may or may not pass; safer to store these dates in a table refreshed quarterly and use FRED `releases/dates` as the machine source. **Nasdaq `economicevents`** (unofficial) is the only free feed with consensus/previous/actual (e.g., Sep 11: PPI consensus 0.4%, Initial Claims 205K) but it timed out from the datacenter twice. Trading Economics' `guest:guest` is gone (410); Finnhub's economic calendar is paid; investing.com has no API and scraping violates its terms.

**Earnings calendar.** Primary: Finnhub `GET /calendar/earnings?from=2026-09-07&to=2026-09-14&token=` → `{"earningsCalendar":[{"date","epsActual","epsEstimate","hour":"bmo|amc|dmh","quarter","revenueActual","revenueEstimate","symbol","year"}]}` (free, key-authenticated, datacenter-safe). Fallback: Nasdaq `GET https://api.nasdaq.com/api/calendar/earnings?date=2026-09-10` with `User-Agent: Mozilla/5.0...`, `Accept: application/json, text/plain, */*`, `Accept-Language: en-US,en;q=0.9` → `data.rows[]{symbol,name,time:"time-pre-market|time-after-hours|time-not-supplied",epsForecast,noOfEsts,lastYearRptDt,lastYearEPS,marketCap,fiscalQuarterEnding}` (38 rows for Sep 10 incl. ORCL, ADBE) — residential fetch only. Yahoo's calendar is HTML; skip.

### A4. Recommended stack

Server-side (Edge Functions; store everything in Supabase tables, the PWA reads those):
1. **Daily OHLCV history:** Tiingo (30+ years adjusted) → Massive Basic (2 years, 5/min) → FMP (US EOD, 5 years).
2. **Quotes/intraday:** Finnhub `/quote` (real-time US, 60/min) → Twelve Data (`quote`/`time_series 5min`, 800 credits/day) → Yahoo v8 (opportunistic, exponential backoff, expect 429).
3. **Crypto candles/spot:** Coinbase Exchange → Kraken → `data-api.binance.vision`; CoinGecko Demo key for universe/market-cap/24h stats.
4. **Macro:** FRED (data + release dates) and BLS API (registered key); FOMC table hardcoded from the Fed page; Nasdaq `economicevents` only from a residential helper if you want consensus numbers.
5. **Earnings:** Finnhub → Nasdaq (residential only).
Client-side (static PWA): do not call vendors directly, keys would ship in the bundle and Tiingo/EODHD/Nasdaq/Yahoo have no CORS anyway. If you ever need a keyless browser call, Coinbase Exchange, Kraken, CoinGecko public, Binance.vision, Twelve Data and BLS all send `Access-Control-Allow-Origin`.

## Part B: OpenRouter

**Chat completions.** `POST https://openrouter.ai/api/v1/chat/completions`. Required header `Authorization: Bearer <OPENROUTER_API_KEY>`; optional attribution headers `HTTP-Referer` (your app URL) and `X-OpenRouter-Title` (alias `X-Title`); `Content-Type: application/json`. Body: `model`, `messages`, `max_tokens`, `response_format`, `provider`, `reasoning`, `models` (fallback list), `plugins`, `stream`. Without a key: 401 `{"error":{"message":"No cookie auth credentials found","code":401}}`; with an invalid key: 401 "User not found."

**Model catalog.** `GET /api/v1/models` is public (no key, CORS `*`, preflight 204): 428 models today. Per model: `id`, `canonical_slug`, `name`, `created`, `context_length`, `architecture{modality,input_modalities,output_modalities,tokenizer}`, `pricing{prompt,completion,image,web_search,internal_reasoning,input_cache_read,input_cache_write,input_cache_write_1h}` (strings, **USD per token**, multiply by 1e6 for $/M), `top_provider{context_length,max_completion_tokens,is_moderated}`, `per_request_limits`, `supported_parameters[]` (union includes `response_format`, `structured_outputs`, `reasoning`, `reasoning_effort`, `include_reasoning`, `tools`, `tool_choice`, `web_search_options`, `verbosity`, `seed`, `logprobs`...), plus newer fields `reasoning{mandatory,default_enabled,supported_efforts,default_effort}`, `knowledge_cutoff`, `default_parameters`, `expiration_date`, `links.details`, `benchmarks`. `GET /api/v1/models/{author}/{slug}/endpoints` (public) lists each provider's price, params, `uptime_last_30m` and long-context price `overrides`. Note that `:online` is not a catalog entry; it is a request-time suffix.

**Structured outputs.** `"response_format":{"type":"json_schema","json_schema":{"name":"verdict","strict":true,"schema":{...}}}`. Only endpoints advertising `structured_outputs` enforce it; add `"provider":{"require_parameters":true}` so OpenRouter routes only to providers that support every parameter you sent (otherwise it may silently pick one that ignores `response_format`); unsupported models return an error. Works with `stream:true`. Provider object also accepts `order`, `allow_fallbacks`, `only`, `ignore`, `data_collection`, `zdr`, `quantizations`, `sort` (`price|throughput|latency`), `max_price`; `models:[...]` gives model-level fallback; `:nitro`/`:floor` suffixes sort by throughput/price.

**Reasoning.** `"reasoning":{"effort":"none|minimal|low|medium|high|xhigh|max"}` or `{"max_tokens":N}` (Anthropic, Gemini, Qwen map to a token budget, minimum 1024), `"exclude":true` hides the trace, `"enabled":true` = medium. Effort maps to a share of `max_tokens` (low ≈20%, medium ≈50%, high ≈80%). Reasoning tokens are billed as output and reported in `usage.completion_tokens_details.reasoning_tokens`. **Gotcha, verbatim from the docs:** for Anthropic "`max_tokens` must be strictly higher than the reasoning budget to ensure there are tokens available for the final response after thinking," or you get empty/truncated JSON. Bigger gotcha from the live catalog: many models reason **by default** (`reasoning.default_enabled:true`): Claude Sonnet 5 / Opus 5 default `high`, GPT-6 Astra mandatory `medium`, Gemini 3.8 Flash mandatory `medium`, Grok 4.6 mandatory `high`, Qwen3.8 Max mandatory `xhigh`, GLM-5.3 and GLM-5.3-Flash mandatory `max`. Always set `effort` explicitly or your output bill is unbounded.

**Usage and cost accounting.** `usage:{include:true}` is now **deprecated and has no effect**; every response already carries `usage{prompt_tokens,completion_tokens,total_tokens,cost,cost_details.upstream_inference_cost,is_byok,prompt_tokens_details{cached_tokens,cache_write_tokens},completion_tokens_details{reasoning_tokens}}` (in streaming, once in the final chunk before `[DONE]`). Per-call audit: `GET /api/v1/generation?id=<response.id>` (auth) → `data{id,total_cost,cache_discount,upstream_inference_cost,model,provider_name,latency,generation_time,finish_reason,native_finish_reason,tokens_prompt,tokens_completion,native_tokens_prompt,native_tokens_completion,native_tokens_reasoning,num_search_results,streamed,cancelled,is_byok}`. Credits/limits: `GET /api/v1/key` (docs path; `/api/v1/auth/key` is live too) → `data{label,limit,limit_remaining,limit_reset,usage,usage_daily,usage_weekly,usage_monthly,is_free_tier,include_byok_in_limit}`; `GET /api/v1/credits` → total credits vs usage.

**Rate limits and errors.** Paid models: no platform-level request caps (provider limits still apply). `:free` variants: 20 req/min and 50 req/day, rising to 1,000/day once you have bought $10 of credits. 429 carries `X-RateLimit-Limit/Remaining/Reset` and `Retry-After`. **402** = "Your account or API key has insufficient credits" (also fires on a negative balance, even for free models) and is not retriable. 403 = moderation/guardrail, 408 timeout, 502 model down, 503 no provider meets your routing constraints (typical when `require_parameters` + `response_format` excludes everyone). Mid-stream failures arrive as an SSE event with `finish_reason:"error"` under HTTP 200.

**Web search.** `model:"x:online"` is exactly `plugins:[{"id":"web"}]`. Default engine is the provider's **native** search for OpenAI, Anthropic, Google, Perplexity and xAI models, otherwise **Exa** at $0.007/request (instant/fast/auto; up to 10 results, +$0.001 each beyond), $0.012 deep, $0.015 deep-reasoning; `engine:"parallel"` $0.001–0.005, `engine:"perplexity"` $0.005; `max_results` default 5. Native per-search prices are in the catalog's `pricing.web_search`: OpenAI and Anthropic $0.01, Google $0.014, xAI $0.005, Perplexity `sonar` $0.005, `sonar-pro-search` $0.018, Meta $0.0025. Citations come back in `message.annotations[]` as `url_citation{url,title,content,start_index,end_index}`.

### Jury shortlist (live ids and prices, $/M input / $/M output; SO = structured_outputs supported)

| Lineage | Model id | $ in / out | Notes |
|---|---|---|---|
| Anthropic | `anthropic/claude-sonnet-5` | 2.00 / 10.00 | 1M ctx, SO, reasoning default high; cache read $0.20 |
| Anthropic | `anthropic/claude-opus-5` | 5.00 / 25.00 | judge-grade; `claude-fable-5.1` is 10/50 |
| Anthropic (cheap) | `anthropic/claude-haiku-4.5` | 1.00 / 5.00 | 200K ctx, SO |
| OpenAI | `openai/gpt-5.6-terra` | 2.00 / 12.00 | SO, reasoning default medium; cutoff 2026-02-16 |
| OpenAI (flagship) | `openai/gpt-6-astra` | 10.00 / 50.00 | released 2026-09-04, reasoning mandatory |
| OpenAI (flash) | `openai/gpt-5.6-luna` | 0.20 / 1.20 | 1M ctx, SO |
| Google | `google/gemini-3.8-flash` | 0.75 / 3.75 | reasoning mandatory; Pro tier on OR is still `google/gemini-3.1-pro-preview` 2/12 |
| Google (flash-lite) | `google/gemini-3.5-flash-lite` | 0.30 / 2.50 | reasoning mandatory, default minimal |
| xAI | `x-ai/grok-4.6` | 2.00 / 6.00 | 500K ctx, reasoning mandatory high, native search $0.005 |
| DeepSeek | `deepseek/deepseek-v4-pro-0813` | 1.049 / 3.148 | SO; `deepseek-v4-flash-0731` 0.14/0.28 for the cheap seat |
| Qwen | `qwen/qwen3.8-max-0902` | 2.00 / 6.00 | reasoning mandatory xhigh; `qwen3.8-flash` 0.15/0.47 |
| Meta | `meta/muse-spark-1.3` | 1.25 / 4.25 | Meta's current line; last open Llama is `meta-llama/llama-4-maverick` 0.20/0.696 (no reasoning) |
| Mistral | `mistralai/mistral-medium-3-5` | 1.50 / 7.50 | `mistral-small-2603` 0.15/0.60 |
| Moonshot | `moonshotai/kimi-k3` | 3.00 / 15.00 | default effort max; `kimi-k2.6` 0.95/4.00 |
| Z.ai | `z-ai/glm-5.3` | 1.40 / 4.40 | reasoning mandatory max; `glm-5.3-flash` 0.075/0.25 |
| MiniMax | `minimax/minimax-m3` | 0.30 / 1.20 | SO, 1M ctx |
| Amazon | `amazon/nova-2-lite-v1` / `nova-premier-v1` | 0.30/2.50 / 2.50/12.50 | **no `response_format`/`structured_outputs`** — exclude from a strict-JSON jury |
| Perplexity (live web) | `perplexity/sonar` | 1.00 / 1.00 + $0.005/search | no SO, no tools: use as news feeder with lenient parsing; `sonar-pro-search` 3/15 + $0.018 has SO; `sonar-reasoning-pro` 2/8 |
| NVIDIA (open) | `nvidia/nemotron-3.5-lightning` | 0.08 / 0.20 | cheapest reasoning+SO seat |

## Part C: Monthly cost of the daily run

Per run: 8 jurors × (analyst 6k in/1.5k out + rebuttal 8k in/1k out = 14k in/2.5k out) + judge 15k in/2k out. Prices are the live catalog values above; "reasoning" rows assume thinking doubles output tokens (many defaults would exceed that).

| Config | Jurors | Judge | $/run | $/mo (22 runs) | $/mo (30 runs) | with 2× output (reasoning) |
|---|---|---|---|---|---|---|
| Cheap | gpt-5.6-luna, gemini-3.5-flash-lite, deepseek-v4-flash-0731, qwen3.8-flash, glm-5.3-flash, mistral-small-2603, minimax-m3, nemotron-3.5-lightning | claude-haiku-4.5 | 0.061 | 1.35 | 1.84 | 0.088/run → 1.94–2.64 |
| Mid | claude-haiku-4.5, gpt-5.6-luna, gemini-3.8-flash, grok-4.6, deepseek-v4-pro-0813, qwen3.8-flash, glm-5.3, kimi-k2.6 | claude-sonnet-5 | 0.225 | 4.95 | 6.75 | 0.315/run → 6.93–9.44 |
| Premium | claude-sonnet-5, gpt-5.6-terra, gemini-3.8-flash, grok-4.6, deepseek-v4-pro-0813, qwen3.8-max-0902, kimi-k3, muse-spark-1.3 | claude-opus-5 | 0.472 | 10.39 | 14.16 | 0.672/run → 14.79–20.17 |
| Flagship | claude-opus-5, gpt-6-astra, gemini-3.8-flash, grok-4.6, deepseek-v4-pro-0813, qwen3.8-max-0902, kimi-k3, mistral-medium-3-5 | claude-fable-5.1 | 0.895 | 19.69 | 26.86 | 1.286/run → 28.30–38.59 |

Per-juror cost in the premium config: sonnet-5 $0.053, gpt-5.6-terra $0.058, gemini-3.8-flash $0.020, grok-4.6 $0.043, deepseek-v4-pro $0.023, qwen3.8-max $0.043, kimi-k3 $0.080, muse-spark-1.3 $0.028; judge opus-5 $0.125. Add-ons: one `perplexity/sonar` news call (3k in/1k out + 1 search) ≈ $0.009/day; Exa `:online` on all 8 jurors ≈ $0.056/run (+$1.2–1.7/mo); native search $0.005–0.014 per call. Levers: pin `reasoning.effort` (low) and `max_tokens`, reuse a shared analyst prefix so Claude's `input_cache_read` ($0.20–0.50/M) applies, and cap spend with a per-key `limit` checked via `/api/v1/key`. OpenRouter's fee on credit purchases is not included above.

## Sources
- OpenRouter docs: [API overview](https://openrouter.ai/docs/api-reference/overview), [structured outputs](https://openrouter.ai/docs/features/structured-outputs), [reasoning tokens](https://openrouter.ai/docs/use-cases/reasoning-tokens), [limits](https://openrouter.ai/docs/api-reference/limits), [usage accounting](https://openrouter.ai/docs/use-cases/usage-accounting), [provider routing](https://openrouter.ai/docs/features/provider-routing), [web search](https://openrouter.ai/docs/features/web-search), [errors](https://openrouter.ai/docs/api-reference/errors), [generation](https://openrouter.ai/docs/api-reference/get-a-generation); live catalog `https://openrouter.ai/api/v1/models` (2026-09-07).
- Market data: [Finnhub issue #546](https://github.com/finnhubio/Finnhub-API/issues/546), [Finnhub pricing](https://finnhub.io/pricing), [Twelve Data pricing](https://twelvedata.com/pricing) and [US equities feed note](https://support.twelvedata.com/en/articles/9935903-us-equities-market-data), [Alpha Vantage limits](https://www.alphavantage.co/premium/), [Massive pricing](https://massive.com/pricing), [Tiingo pricing](https://www.tiingo.com/about/pricing), [EODHD limits](https://eodhd.com/financial-apis/api-limits) and [pricing](https://eodhd.com/pricing), [FMP plans](https://site.financialmodelingprep.com/pricing-plans), [Nasdaq Data Link limits](https://help.data.nasdaq.com/article/490-is-there-a-rate-limit-or-speed-limit-for-api-usage), [marketstack](https://marketstack.com/pricing), [Yahoo API guide](https://scrapfly.io/blog/posts/guide-to-yahoo-finance-api), [Stooq notes](https://apis.io/providers/stooq/).
- Crypto: [CoinGecko pricing](https://www.coingecko.com/en/api/pricing) and [rate-limit docs](https://docs.coingecko.com/docs/common-errors-rate-limit), [Binance 451 discussion](https://github.com/ccxt/ccxt/issues/15891), [Coinbase candles](https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproductcandles) and [rate limits](https://docs.cdp.coinbase.com/exchange/docs/rate-limits), [Kraken OHLC](https://docs.kraken.com/api/docs/rest-api/get-ohlc-data) and [rate limits](https://support.kraken.com/articles/206548367-what-are-the-api-rate-limits-), [CoinDesk free-tier retirement](https://data.coindesk.com/blogs/changes-to-coindesk-data-indices-api-free-tier-access).
- Macro/calendars: [FRED releases/dates](https://fred.stlouisfed.org/docs/api/fred/releases_dates.html), [FRED rate limit](https://econindx.com/guides/getting-started-fred/), [BLS API FAQ](https://www.bls.gov/developers/api_faqs.htm), [BLS CPI schedule](https://www.bls.gov/schedule/news_release/cpi.htm), [BLS Employment Situation schedule](https://www.bls.gov/schedule/news_release/empsit.htm), [FOMC calendar](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm).
- Infra: [Supabase: no static egress IPs](https://supabase.com/docs/guides/troubleshooting/why-supabase-edge-functions-cannot-provide-static-egress-ips-for-whitelisting-3d78b0), [Cloudflare WAF vs Edge Functions](https://community.cloudflare.com/t/cloudflare-waf-blocking-legitimate-api-requests-from-supabase-edge-functions-to-pol/869437).
