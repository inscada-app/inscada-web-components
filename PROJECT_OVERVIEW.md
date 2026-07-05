# @inscada/web-components — Detaylı Proje Rehberi

**Son güncelleme:** 2026-07-05
**Sürüm:** 2.0.0-alpha.1
**Konum:** `C:/Users/HP/Projects/web-components/`
**Repository:** `git+https://github.com/inscada-app/inscada-web-components.git`

Bu doküman projedeki her dosyanın ne işe yaradığını, mimari kararları ve neden böyle yapıldığını anlatır. README.md son kullanıcı için hazırlandı; burası **maintainer'ın uzun süre uzak kaldıktan sonra tekrar oryantasyon için** yazıldı.

---

## Proje ne?

inSCADA custom HTML sayfalarında **canlı SCADA verisi + faceplate render + REST fetch** için sıfır-bağımlılıklı Web Components kütüphanesi. Her `<ins-*>` tag'i tek satır HTML ile inSCADA REST API'sine bağlanır — auth cookie, X-Space header, setInterval, DOM manipulation boilerplate'i yok.

**Kritik özellik:** Bir sayfada 20 component varsa 20 değil **1 API call** olur — DataBus singleton'ı project bazında subscription'ları gruplandırıp tek batch fetch atar.

**İki ortam desteği:**
- **Iframe modu** (inSCADA Custom HTML iframe içinde): `window.InscadaApi` proxy'si üzerinden postMessage bridge kullanır — sandbox iframe null origin CORS problemini aşar
- **Standalone modu** (main app origin'de bir SPA parçası olarak): Direkt `fetch(url, {credentials: 'include'})` — session cookie ile

Auto-detect: iframe'de `window.InscadaApi` varsa proxy, yoksa standalone. Transport katmanı bunu şeffaf yönetir.

---

## Klasör yapısı

```
web-components/
├── PROJECT_OVERVIEW.md         ← bu dosya
├── README.md                   ← son kullanıcı için (basitleştirilmiş, EN/TR)
├── package.json                ← @inscada/web-components 2.0.0-alpha.1, ESM
├── package-lock.json
├── .gitignore
├── src/                        ← kaynaklar (import ile modüler)
│   ├── index.js                ← entry point + customElements.define
│   ├── ins-data-bus.js         ← singleton batch fetch coordinator
│   ├── ins-live-value.js       ← <ins-live-value> — tek değer gösterimi
│   ├── ins-variables.js        ← <ins-variables> — headless çok-değişkenli provider
│   ├── ins-fetch.js            ← <ins-fetch> — generic REST endpoint fetcher
│   ├── ins-faceplate.js        ← <ins-faceplate> v2 — faceplate SVG renderer
│   └── transport/
│       └── index.js            ← proxy/fetch abstraction (iframe vs standalone)
├── dist/
│   └── ins-components.min.js   ← esbuild IIFE bundle (`window.InsComponents`)
└── node_modules/
    └── esbuild
```

**Build:** `npm run build` → esbuild IIFE bundle üretir (`dist/ins-components.min.js`, ~26 KB), `<script src>` ile custom HTML'e gömülür.

---

## Dosyalar — Ne işe yararlar

### `package.json`

- **name:** `@inscada/web-components`
- **version:** `2.0.0-alpha.1` (major bump 2026-07-05, ins-faceplate v2 iframe-first refactor)
- **type:** `"module"` — ESM (source), esbuild IIFE bundle üretir
- **main:** `src/index.js`
- **build script:** `esbuild src/index.js --bundle --minify --format=iife --global-name=InsComponents --outfile=dist/ins-components.min.js`
- **devDependencies:** yalnızca `esbuild`

**Neden IIFE?** Custom HTML iframe'inde ES modules yükleme (`<script type="module">`) sandbox kısıtları altında pratik değil. IIFE tek dosya, `window.InsComponents` global'i, cross-browser stabil.

**Neden zero-dep?** Custom HTML iframe CSP'si sıkı, dış CDN'lere fazla bağımlı olmak istemezsin. Bundle self-contained.

---

### `src/index.js` — Entry point (57 satır)

Kütüphanenin giriş noktası. İki iş yapar:

1. **Import + auto-register.** Bütün web component sınıflarını import eder, `customElements.define(...)` ile browser'a tanıtır (bir kez, `if (!customElements.get(...))` guard'ıyla):
   ```js
   if (!customElements.get('ins-live-value')) {
     customElements.define('ins-live-value', InsLiveValue);
   }
   // aynı guard: ins-variables, ins-faceplate, ins-fetch
   ```
2. **Re-export.** Component sınıfları, `dataBus`, ve `Transport` API'sini named export olarak dışa açar — modüler kullanım için (`import { setConfig } from '@inscada/web-components'`).

Bu dosyayı düzenleyeceğin durumlar: yeni bir component eklendiğinde `import` + `customElements.define` + export ekle.

---

### `src/transport/index.js` — Transport katmanı (227 satır)

**Kritik mimari parça.** HTTP çağrılarını iki farklı ortama uyarlar:

- **Iframe modu:** `window.InscadaApi` mevcut ve `window.parent !== window` → InscadaApi proxy kullan (`api.getVariableValues(...)`, `api.rest(...)`). postMessage → parent SPA → REST call → response geri.
- **Standalone modu:** Direkt `fetch(url, { credentials: 'include', headers: { 'X-Space': space } })`

**Auto-detect** (`_detectProxyMode()`):
```js
typeof window.InscadaApi === 'function' && window.parent !== window
```

**Konfigürasyon:**
- `setConfig({ baseUrl, space })` — standalone modda base URL/space
- `setConfig({ token })` — **AÇIKÇA yasak**, `throw new Error(...)`; v1.1 scoped JWT plan
- `getConfig()`, `setTransport(mockInstance)` — test için mock injection

**Metodlar:**

| Metod | Iframe modu | Standalone modu |
|---|---|---|
| `fetchVariables(project, names)` | `api.getVariableValues(names)` | `GET /api/variables/values/by-project-name-and-names?projectName=X&names=A&names=B` |
| `runScript(scriptId)` | (yok, sandbox blocklu) | `POST /api/scripts/{id}/run` |
| `runAdHocScript(payload)` | (yok) | `POST /api/scripts/runner` |
| `resolveProjectId(projectName)` | cached, gerektiğinde `/by-name` | aynı |
| `loadFaceplate(projectName, name)` | **(kırık — sandbox port `/api/faceplates/*` allowlist'te değil)** | Fetch: def + svg + elements + placeholders paralel |
| `fetchExternalUrl(url, opts)` | `api.rest(method, url, ...)` — server-side allowlist | Direkt fetch, target CORS gerektirir |

**`loadFaceplate` iframe modunda çalışmaz** — CSP `frame-ancestors` `/api/faceplates/*` endpoint'lerine sandbox port 8083'ten erişimi bloklar. Bu yüzden `<ins-faceplate>` v2 bu yolu terk edip inline metadata pattern'e geçti (aşağıda anlatılıyor).

**Cache:** `_apiCache` (projectName → InscadaApi instance), `_projectIdCache` (projectName → uuid).

---

### `src/ins-data-bus.js` — Singleton batch coordinator (186 satır)

**Amaç:** Sayfadaki N tane `<ins-live-value>` / `<ins-variables>` component'i **tek batched fetch** yapsın — 20 tag = 1 API call per project per tick.

**API:**
```js
dataBus.subscribe(projectName, varName, callback);
dataBus.unsubscribe(projectName, varName, callback);
dataBus.refreshNow();      // manuel tick
dataBus.refreshMs = 3000;  // interval değiştir (min 500)
dataBus.space = 'other_space';  // Transport'a delege
```

**Nasıl çalışıyor:**
1. `subscribe()` → `_subscribers.set("projectName:varName", Set<callback>)`
2. İlk subscription geldiğinde `_startPolling()` (setInterval)
3. Her tick'te `_tick()`:
   - `_subscribers`'ı `projectName → [varName, ...]` şeklinde grupla
   - Her project için `transport.fetchVariables(projectName, names)` — batch call
   - Response `Map<name, {value, date}>` → matching subscriber callback'lerine dispatch
4. Son subscriber gittiğinde `_stopPolling()`

**Visibility-aware:** `document.hidden === true` iken polling **duraklar**, tab görünür olunca kaldığı yerden devam. Bandwidth tasarrufu.

**Singleton pattern:** `window.__insDataBus = new InsDataBus()` — sayfada tek instance. Aynı script iki kez yüklense bile `if (!window.__insDataBus)` guard'ı ikinci init'i engeller.

**Error handling:** Her subscriber `try/catch` içinde çağrılır — bir callback throw etse diğerlerini bozmaz.

---

### `src/ins-live-value.js` — Tek değer gösterimi (176 satır)

Basit Web Component: bir tag = bir canlı değer.

**Kullanım:**
```html
<ins-live-value project="AYBIGE_HES" variable="Temp_In"
  unit="°C" label="Sıcaklık" decimals="1"
  thresholds="0:blue,30:green,60:orange,80:red">
</ins-live-value>
```

**Özellikler:**

| Attribute | Görev |
|---|---|
| `project` | inSCADA project NAME (JDK21 string, zorunlu) |
| `variable` | Variable name (zorunlu) |
| `unit` | Görsel birim (°C, kW, bar) |
| `label` | Görsel etiket |
| `decimals` | `toFixed(N)` (varsayılan raw string) |
| `format` | `"raw"` → değeri olduğu gibi göster |
| `thresholds` | `"min:renk,..."` — sıralı, mevcut değer üstüne düştüğü en yüksek eşiğin rengini uygula |

**Shadow DOM:** Stil izolasyonu (`:host` `.label` `.value` `.unit` `.error`). CSS custom properties'e izin verir (`--value-color`, `--label-color`, `--stale-opacity`).

**Stale detection:** 3 ardışık tick veri gelmezse `.stale` class'ı eklenir (opacity düşürerek görsel geri bildirim). Veri gelmeye başlarsa otomatik `.remove('stale')`.

**Lifecycle:**
- `connectedCallback` → `dataBus.subscribe(project, variable, this._callback)`
- `disconnectedCallback` → `dataBus.unsubscribe(...)`
- `attributeChangedCallback('project'|'variable')` → unsubscribe + re-subscribe

---

### `src/ins-variables.js` — Headless multi-variable provider (248 satır)

Çoklu değişkeni tek yerden yönetir; **görsel değil**, veri sağlar. Charts, custom widgets, template binding için.

**Kullanım A — Programatik/reaktif:**
```html
<ins-variables id="plant" project="AYBIGE_HES"
  variables="Temp_In, Pressure, Flow_Rate" refresh="2000">
</ins-variables>

<script>
  const plant = document.getElementById('plant');

  // Event-based reactive
  plant.addEventListener('ins-data-update', e => {
    // e.detail = { Temp_In: {value, date}, Pressure: {value, date}, ... }
    chart.update(e.detail);
  });

  // Or imperative
  const t = plant.getValue('Temp_In');   // {value, date}
  const all = plant.getValues();          // full snapshot

  // Or callback subscribe (auto-cleanup)
  const off = plant.subscribe(data => chart.update(data));
</script>
```

**Kullanım B — Template binding (JS yazmadan):**
```html
<ins-variables project="AYBIGE_HES" variables="Temp_In, Pressure">
  <template>
    <div>Temp: <b data-bind="Temp_In">--</b> °C</div>
    <div>Pressure: <b data-bind="Pressure" data-bind-format="0.2">--</b> bar</div>
    <div style="background:red" data-bind="StatusColor" data-bind-attr="style"></div>
  </template>
</ins-variables>
```

**Template binding modifier'ları:**
- `data-bind="Var"` → `textContent` (varsayılan)
- `data-bind-format="0.2"` → `toFixed(2)`
- `data-bind-attr="fill"` → element attribute'una yaz
- `data-bind-style="background"` → inline style property'sine yaz

**Public API:**
- `.getValue(name)` — tek değişken snapshot
- `.getValues()` / `.data` (getter) — tam snapshot
- `.subscribe(cb)` → returns unsubscribe fn

**Events:**
- `ins-data-update` (bubbles, composed) — detail = tam snapshot (microtask-batched — birden çok değişken aynı tick'te gelirse tek event)
- `ins-data-error` — detail = `{variable, error}`

**Not:** v0.3'te `<ins-data-source>` adıydı, v1.0'da `<ins-variables>` oldu — semantic netleştirme (variable read vs REST fetch).

---

### `src/ins-fetch.js` — Generic REST endpoint fetcher (291 satır)

`<ins-variables>` yalnızca inSCADA variables'a bağlanır; `<ins-fetch>` **rastgele REST URL** için. Iframe'de InscadaApi proxy'nin `rest()` methodu (server-side allowlist ile), standalone'da direkt fetch.

**Kullanım A — Headless:**
```html
<ins-fetch id="summary"
  url="https://vpn.inscada.online/api/internal/plant-summary?plant=aybigehes"
  refresh="10000"
  project="AYBIGE_HES">
</ins-fetch>

<script>
  document.getElementById('summary').addEventListener('ins-data-update',
    e => render(e.detail));   // e.detail = parsed JSON body
</script>
```

**Kullanım B — Template binding (dot-notation nested):**
```html
<ins-fetch url="..." refresh="10000">
  <template>
    <h2 data-bind="plant_name">--</h2>
    <span data-bind="channels.active">--</span> / <span data-bind="channels.total">--</span>
  </template>
</ins-fetch>
```

**Attributes:**
- `url` (zorunlu)
- `method` (varsayılan `GET`)
- `refresh` (varsayılan `10000` ms, `0` → one-shot, min 500)
- `project` — proxy modda hangi InscadaApi instance kullanılacak (server-side URL allowlist project-scoped)
- `parse` — `json` (default) | `text` | `auto`
- `timeout` — TBD (şu an transport'a bırakıyor)

**Public API:**
- `.getData()` / `.data` — son başarılı response
- `.subscribe(cb)`
- `.refresh()` — manuel fetch
- `.isStale` — son fetch fail ama önceki başarı varsa true

**Events:** `ins-data-update`, `ins-data-error` (statusCode dahil)

**Visibility-aware:** DataBus gibi, tab gizliyken timer duraklar.

**In-flight protection:** `_inFlight` flag — aynı anda iki fetch başlatılmaz.

---

### `src/ins-faceplate.js` — Faceplate renderer v2 (632 satır) 🔥

**Kütüphanenin en karmaşık ve en yeni component'i.** 2026-07-05'te full refactor edildi (v1 → v2). Iframe-first tasarım.

#### Ne yapar

inSCADA'nın **faceplate** (yeniden kullanılabilir SVG-based sembol şablonu — relay, motor, valf, feeder gibi) konseptini custom HTML'de render eder. SVG dosyası + placeholder'lar + element expression'ları tek `<ins-faceplate>` tag'iyle canlı çalışır durumda görüntülenir.

**Kullanım:**
```html
<ins-faceplate
  svg-path="faceplates/H01_FeederTemplate.svg"
  project="PALANDOKEN_GES"
  brand="Siemens 7SJ82"
  cb_status="CB01_STATUS"
  poll="2000">
  <script type="application/json">
    {
      "placeholders": [
        {"name":"brand","type":"text"},
        {"name":"cb_status","type":"tag"}
      ],
      "elements": [
        {"dom_id":"label","type":"Get","expression_type":"EXPRESSION",
         "expression":"return '$brand$';","props":"{}"},
        {"dom_id":"cb_body","type":"Color","expression_type":"EXPRESSION",
         "expression":"return ins.getVariableValue('$cb_status$').value ? '#0c0' : '#c00';",
         "props":"{\"property\":\"fill\"}"}
      ]
    }
  </script>
</ins-faceplate>
```

#### v2 tasarım kararları (2026-07-05)

**1. Inline metadata.** Elements + placeholders `<script type="application/json">` çocuk elementinde veya `metadata` attr'ında. **Runtime'da `/api/faceplates/*` fetch YOK.** Sebep: sandbox port `SandboxPortSecurityFilter` bu endpoint'i bloklar (allowlist'te yok). LLM (Cloud MCP faceplate tool'larıyla) design-time'da metadata çeker, concrete JSON gömer.

**2. SVG sandbox-safe asset.** `svg-path="faceplates/X.svg"` → `/api/custom-html/assets/faceplates/X.svg`. Bu iframe'in tek izinli dosya route'u. Alternatif olarak `svg-content` attr'ında raw SVG string (küçük/test SVG'ler için).

**3. Client-side expression eval.** Expression'lar `new Function()` içinde çalışır — `ins` shim'i son polling cache'e bakar. Backend script runner sandbox'ta bloklu, ayrıca gereksiz: inSCADA'nın ürettiği expression'lar Nashorn ES5, tarayıcı da anlar.

**4. Metadata snake_case.** MCP tool output'una birebir uyumlu (`dom_id`, `expression_type`) — LLM copy/paste'te rename gerektirmez.

**5. Batch polling.** Placeholder tag'leri + expression'daki `ins.getVariableValue('X')` regex tarayışıyla otomatik tag set. Tek `api.getVariableValues([...])` çağrısı `poll` ms'de.

#### Element type handler'ları

9 tip destekleniyor (v1'den korundu):

| Type | Ne yapar |
|---|---|
| `Get` | Element text content veya `<tspan>` çocuk (SCADA convention: tspan varsa oraya yaz) |
| `Color` | `style[property]` (default `fill`); `"color1/color2"` split ile blink animation |
| `Opacity` | `style.opacity = parseFloat(value)` |
| `Visibility` | `style.display = value ? '' : 'none'` |
| `Rotate` | `transform="rotate(angle, cx, cy)"` — props'tan cx/cy |
| `Bar` | Rectangle width/height oranı; `data-orig-*` attr'lara memo, Bottom/Top/Left/Right orientation |
| `Blink` | `setInterval` ile visibility toggle |
| `Move` | `transform="translate(X, 0)"` veya Y |
| `Scale` | `transform="scale(N)"` |

**`_apply(def, value)`** — element type'a göre uygun DOM mutation.

**Placeholder marker:** `$name$` (dollar-sarılı) — inSCADA UI convention'ı. Component `_substitute()` case-insensitive regex ile placeholder attr değerlerini expression'lardaki markerları değiştirir. MCP handler tarafında da wrap/strip mevcut.

**Debug flag:** `debug` attribute → console.warn ile eval failure/missing element/etc. görünür olur.

#### v1'den ne değişti — özet

- **Shadow DOM YOK.** V1'de shadow root'ta `<object>` DOM erişimi tarayıcıya göre değişiyordu; light DOM'a geçildi
- **`<object data="…svg">` YOK.** CSP `frame-ancestors 'self' ...` port 8083'ü içermediği için bloklu
- **`fetch()` YOK.** Sandbox iframe origin `null`, CORS reddi
- **`new Function()` VAR.** CSP `script-src` `unsafe-eval` gerekiyor bu iframe için var (`script-src 'self' 'unsafe-inline'` — inline scripts izinli, eval OK Chrome'da)
- **Metadata inline.** Runtime fetch yok, LLM MCP'den çeker paste eder
- **MutationObserver.** Attribute değişimini izler (`observedAttributes` static olsa da property-driven değişikliği yakalar); MCP-friendly (LLM `fp.setAttribute('brand', ...)` yazar, otomatik re-render)

#### Uzun vadeli — v3'e ertelenen

- Nested faceplate rendering (bir faceplate içinde başka faceplate)
- `client_api: true` tipler (Chart / Datatable / Slider / Peity)
- API-mode metadata fetch — backend'e `/api/faceplates/{id}/render` sandbox-allowed endpoint eklenirse, `svg-path` yerine `faceplate-name` attr'ıyla otomatik fetch

---

## Mimari — data flow

```
                                  ┌─────────────────────────┐
                                  │  Custom HTML iframe     │
                                  │  (sandbox='allow-scripts│
                                  │   allow-forms')         │
                                  │  origin: null           │
                                  └────────┬────────────────┘
                                           │
                       ┌───────────────────┼────────────────────┐
                       │                   │                    │
              <ins-live-value>      <ins-variables>       <ins-faceplate>
                       │                   │                    │
                       └──────────┬────────┘                    │
                                  │                             │
                          ┌───────▼────────┐                    │
                          │ InsDataBus     │                    │
                          │ (singleton)    │                    │
                          │ subscribe()    │                    │
                          │ tick()         │                    │
                          └───────┬────────┘                    │
                                  │                             │
                                  │  ┌──────────────────────────┘
                                  │  │  (own polling loop —
                                  │  │   uses transport directly)
                                  ▼  ▼
                          ┌──────────────────┐
                          │ Transport        │
                          │ auto-detect      │
                          └──────┬───────────┘
                                 │
                    ┌────────────┴─────────────┐
                    │                          │
             iframe modu               standalone modu
                    │                          │
        window.parent.postMessage        fetch(url,
        InscadaApi proxy                  {credentials:'include'})
                    │                          │
                    ▼                          ▼
        Parent SPA (main origin)        Same origin server
        │
        POST /api/scripts/call-api  (ins.method(args) reflection)
        POST /api/scripts/run       (ad-hoc code)
        POST /api/scripts/runner    (varsa)
        ↓
     inSCADA Backend REST API
```

**Kritik gözlem:** DataBus **yalnızca variable-value polling'ini yönetir**. `<ins-faceplate>` kendi polling loop'unu tutar (çünkü her faceplate'in own `poll` cadence'ı, own tag set'i olabilir), `<ins-fetch>` ayrı bir polling'i yönetir. DataBus paylaşım avantajı sadece variable'da.

---

## Build & deploy

### Build
```bash
cd C:/Users/HP/Projects/web-components
npm install     # ilk kez
npm run build   # → dist/ins-components.min.js (IIFE, ~26 KB)
```

esbuild bundle strategy:
- **format=iife** — self-contained, `window.InsComponents` global'i
- **--minify** — production için
- **--global-name=InsComponents** — imports olsa da IIFE'ye sıkıştırılıp global'e attach

### Custom HTML'de kullanım — CDN
```html
<script src="https://cdn.jsdelivr.net/npm/@inscada/web-components/dist/ins-components.min.js"></script>
```
NPM publish gerektirir (`npm publish --access public`). Şu an v2 alpha, publish bekliyor.

### Custom HTML'de kullanım — self-hosted asset
NPM publish beklemeden `dist/ins-components.min.js`'i inSCADA'ya asset olarak upload et (published: true), sonra:
```html
<script src="/api/custom-html/assets/libs/ins-components-min.js"></script>
```
Sandbox iframe'de aynı-origin resource loading, CORS/CSP problem yok.

### NPM modu (SPA projesi içinde)
```bash
npm install @inscada/web-components
```
```js
import '@inscada/web-components';   // auto-registers custom elements
```

---

## Session evolution (sürüm tarihi)

- **v0.1.3** (2024 initial commit)
- **v0.3.0** — `<ins-data-source>` (bugün `<ins-variables>`) headless data provider eklendi
- **v1.0.0-beta.1** — Transport abstraction (proxy/fetch auto-detect), JDK21-only
- **v1.0.0-beta.2** — `fetchVariables` iframe modunda InscadaApi proxy kullanır (v1.0 stable release'e giden path)
- **v2.0.0-alpha.1** (2026-07-05) — **`<ins-faceplate>` v2 major refactor.** Aynı gün:
  - Shadow DOM → light DOM
  - `<object>` → inline SVG (svg-content / svg-path)
  - `_compileElements()` → resolver pattern (setResolvers)
  - `coerceJsonString` fix (claude.ai string→object coerce)
  - `wrapPlaceholderName` / `unwrapPlaceholderName` UI parity
  - `_findSvgEl`, tspan-aware Get, blink split, Bar data-orig-* memo — v1'den korundu

---

## Bilinen kısıtlar (custom HTML iframe context)

Bu bilgiler `docs/` altında yok, kaynak koddaki comment'lerde dağınık — buraya konsolide ettim:

- **`fetch()` bloklu** (sandbox null origin, server CORS `Access-Control-Allow-Origin: null` göndermez)
- **`<object data="…">` bloklu** (`CSP frame-ancestors 'self' https://ejder3200.inscada.online https://ejder3200.inscada.online` port 8083'ü içermez)
- **`<iframe src="…">` bloklu** (aynı CSP)
- **`new Function()` ÇALIŞIR** (backend commit `ins.custom-html.csp.script-src` config; `'unsafe-inline'` set, eval izinli Chrome default'unda)
- **`<img src="…svg">` ÇALIŞIR** (`img-src 'self' data:`) ama JS SVG içeriğine erişemez (opaque resource)
- **`<script src="…">` ÇALIŞIR** (`script-src 'self' 'unsafe-inline' https:`)
- **`api.readPublishedFile(path)` — parent SPA'da mevcut ama** `InscadaApi.call()` response'ta raw String için `JSON.parse` crash yapıyor (`tools/BUG_scripts_callapi_raw_string_response.md`)
- **Server-side script pattern** (`asset_reader` — `setGlobalObject` + `executeScript`) — file okuma için tek stabil sandbox-safe yol (bkz. `~/.claude/projects/C--Users-HP-inSCADAJDK21/memory/project_custom_html_runtime_asset_pattern.md`)

---

## Sıradaki iş / roadmap

**v2 stable'a giden yol:**

- [ ] `<ins-faceplate>` v2 nested Faceplate tipi
- [ ] `client_api: true` types (Chart / Datatable / Slider / Peity) — Chart.js gibi CDN'e bağımlı; `script-src` CSP allowlist kontrol
- [ ] `<ins-faceplate>` API mode — backend'e sandbox-allowed `/api/faceplates/{id}/render` endpoint eklenirse
- [ ] NPM publish (v2.0.0)
- [ ] Test suite — component-level unit tests (Jest/Vitest); şu an manuel testing
- [ ] Guide site (`docs/` veya GitHub Pages) — README'yi genişlet
- [ ] `<ins-live-value>` `precision` attr (`decimals` + `format` yerine tek attr)
- [ ] `<ins-fetch>` timeout, retry, backoff

**Backend fix'i beklenen özellikler:**

- Muhammed'e ticket `tools/BUG_scripts_callapi_raw_string_response.md` — `/scripts/call-api` raw String JSON.parse crash fix'lenirse `api.readPublishedFile(path)` doğrudan çalışır, `asset_reader` script pattern'ine gerek kalmaz
- Yeni endpoint önerisi (opsiyonel): `POST /api/scripts/runCode` — ad-hoc code inline execute (backend'de var, parent SPA proxy'de yok — 2 satır UI kod)
- Sandbox iframe için `frame-ancestors` port 8083 ekle → `<object>` framing açılır (basit alternate render path)

---

## Test / doğrulama nasıl yaparım

**Local (standalone modu):**
```bash
cd web-components
npm run build
# dist/ins-components.min.js hazır
# Simple index.html yazıp <script src="dist/..."> ile aç, inSCADA local instance'a bağlan
```

**Iframe modu:**
1. `dist/ins-components.min.js`'i inSCADA'ya published asset olarak yükle (Cloud MCP `upload_file`, `target_subdirectory: "libs"`, `published: true`)
2. Bir Custom HTML yarat, HTML'inde `<script src="/api/custom-html/assets/libs/ins-components-min.js">` ekle
3. `<ins-live-value>`, `<ins-variables>`, `<ins-faceplate>` tag'leriyle test
4. Platform'da custom HTML'i menüye bağla veya doğrudan `/api/custom-html/{id}/render` URL'ini iframe'de aç

---

## İlgili doküman / referans

- **Memory:**
  - `project_faceplate_mcp_and_html_embedding.md` — Faceplate MCP tool paketi (17 CRUD tool) + HTML embed pattern
  - `project_custom_html_runtime_asset_pattern.md` — asset_reader script pattern (SVG runtime load)
  - `feedback_custom_html_inscadaapi.md` — Custom HTML InscadaApi kuralları
  - `feedback_faceplate_single_put_bug.md` — Backend faceplate single-PUT bug (Muhammed fix 2026-06-23)
  - `feedback_verify_old_mcp_rules.md` — Guide'a inanma, kaynak koddan doğrula
- **Backend commit'ler:**
  - `3477bfd63` (2026-06-15) — `ins.readPublishedFile` bridge API
  - `79ee16cd6` (2026-06-23) — Faceplate `@NonUpdatable` faceplateId fix
- **MCP:**
  - `inscada-mcp-cloud/src/tools/faceplate.mjs` + `handlers/faceplate.mjs` — 17 CRUD tool
  - `inscada-mcp-cloud/guides/jdk21/faceplate.md` — LLM için faceplate guide
- **Tools:**
  - `tools/BUG_scripts_callapi_raw_string_response.md` — açık ticket (Muhammed'de)
  - `tools/BUG_faceplate_single_put_400.md` — kapalı (79ee16cd6 ile fix'lendi)

---

## Bakım checklist'i (uzun aradan sonra dönerken)

1. `git status` — çalışan branch'te ne varsa
2. `git log --oneline -5` — son commit'ler
3. `git -C ../inscada-mono log --oneline --since='30 days ago' | head` — backend'de yeni ne var
4. `/inscada-backend-check` skill — MCP-etkileyen commit'leri gör
5. `npm run build` — bundle güncel mi (dist/ modified vs src/)
6. `cat package.json | jq .version` — mevcut sürüm
7. Bu doküman güncel mi — son sürümü ve son değişiklik tarihini yansıtıyor mu

---

**Bu dokümana yeni bir bölüm eklenirse:** üst blokta "Son güncelleme" tarihini bump'la, TOC'a satır ekle, ilgili "Sıradaki iş" checkbox'ını işaretle.
