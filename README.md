# @inscada/web-components

## Overview / Genel Bakis

**EN:** A zero-dependency Web Components library for building live SCADA dashboards on inSCADA custom menus. Instead of writing repetitive fetch/auth/header boilerplate every time, just drop a single HTML tag and get real-time data from inSCADA REST API — with automatic batch fetching, threshold-based coloring, and stale data detection built in.

**TR:** inSCADA custom menulerde canli SCADA panosu olusturmak icin sifir bagimliligi olan bir Web Components kutuphanesi. Her seferinde tekrar tekrar fetch/auth/header kodu yazmak yerine, tek bir HTML tag'i ile inSCADA REST API'den canli veri alin — otomatik toplu veri cekme, esik bazli renklendirme ve bayat veri tespiti dahil.

### Why? / Neden?

**EN:** Building custom menus in inSCADA often requires repeating the same boilerplate: authentication cookies, `X-Space` headers, `setInterval` for live updates, manual DOM manipulation. This library eliminates all of that. Every `<ins-*>` component on the page automatically shares a single DataBus that batches API requests by project — so 20 components on a page make 1 API call, not 20.

**TR:** inSCADA'da custom menu olusturmak genellikle ayni boilerplate kodun tekrarini gerektirir: authentication cookie'leri, `X-Space` header'lari, canli guncelleme icin `setInterval`, manuel DOM manipulasyonu. Bu kutuphane bunlarin hepsini ortadan kaldirir. Sayfadaki her `<ins-*>` component'i otomatik olarak tek bir DataBus'i paylasilir ve API istekleri proje bazinda gruplanir — yani sayfada 20 component varsa 20 degil, 1 API cagrisi yapilir.

### How it works / Nasil calisir

```
Page load
  |
  v
<ins-live-value> connectedCallback()
  |
  v
DataBus.subscribe(projectId, varName, callback)
  |
  v
DataBus groups by projectId, starts polling (every 2s)
  |
  v
Single batch fetch: GET /api/variables/values?projectId=X&names=A,B,C
  (credentials: "include" -> inSCADA session cookie automatic)
  (X-Space header -> DataBus.space property)
  |
  v
Response dispatched to each subscribed component
  |
  v
Component updates its Shadow DOM (value, color, stale state)
```

---

## Installation / Kurulum

### CDN (Recommended for Custom Menus / Custom Menuler icin Onerilen)
```html
<script src="https://cdn.jsdelivr.net/npm/@inscada/web-components/dist/ins-components.min.js"></script>
```

### npm
```bash
npm install @inscada/web-components
```
```js
import '@inscada/web-components';
```

---

## Components / Bilesenler

### `<ins-live-value>` — Live Value Display / Canli Deger Gosterimi

**EN:** Displays a live variable value from inSCADA with automatic polling, threshold-based color changes, and stale data detection.

**TR:** inSCADA'dan otomatik polling ile canli degisken degerini gosterir; esik bazli renk degisimi ve bayat veri tespiti dahildir.

#### Basic Usage / Temel Kullanim
```html
<ins-live-value project="103" variable="Temp_In" unit="°C" label="Sicaklik"
  decimals="1" thresholds="0:blue,30:green,60:orange,80:red">
</ins-live-value>
```

#### Attributes / Ozellikler

| Attribute | Type | Required / Zorunlu | Description / Aciklama |
|-----------|------|---------------------|------------------------|
| `project` | number | Yes / Evet | inSCADA project ID |
| `variable` | string | Yes / Evet | Variable name / Degisken adi |
| `unit` | string | No / Hayir | Unit label (°C, kW, bar...) / Birim etiketi |
| `label` | string | No / Hayir | Display label / Gosterim etiketi |
| `decimals` | number | No / Hayir | Decimal places / Ondalik basamak sayisi |
| `thresholds` | string | No / Hayir | Color thresholds / Renk esikleri: `"0:blue,30:green,60:orange,80:red"` |
| `format` | string | No / Hayir | `"raw"` = display value as-is / degeri oldugu gibi goster |

#### Thresholds / Esik Degerleri

**EN:** The `thresholds` attribute defines color ranges. Format: `"value:color,value:color,..."`. The component picks the color of the highest threshold that the current value meets or exceeds.

**TR:** `thresholds` ozelligi renk araliklerini tanimlar. Format: `"deger:renk,deger:renk,..."`. Component, mevcut degerin karsiladigi veya astigi en yuksek esigin rengini secer.

```html
<!-- Below 0: blue, 0-29: blue, 30-59: green, 60-79: orange, 80+: red -->
<!-- 0 alti: mavi, 0-29: mavi, 30-59: yesil, 60-79: turuncu, 80+: kirmizi -->
<ins-live-value project="103" variable="Temp_In"
  thresholds="0:blue,30:green,60:orange,80:red">
</ins-live-value>
```

#### Stale Data Detection / Bayat Veri Tespiti

**EN:** If no data arrives for 3 consecutive polling cycles (6 seconds by default), the component fades to indicate a stale connection. It automatically recovers when data resumes.

**TR:** Art arda 3 polling dongusunde (varsayilan 6 saniye) veri gelmezse, component soluklaşarak baglantinin bayat oldugunu gosterir. Veri gelmeye devam ettiginde otomatik olarak normale doner.

#### CSS Custom Properties / CSS Ozel Degiskenleri

```css
ins-live-value {
  --value-color: #333;      /* Value text color / Deger metin rengi */
  --label-color: #888;      /* Label text color / Etiket metin rengi */
  --unit-color: #888;       /* Unit text color / Birim metin rengi */
  --stale-opacity: 0.4;     /* Opacity when stale / Bayat durumda saydamlik */
}
```

#### Examples / Ornekler

```html
<!-- Simple value / Basit deger -->
<ins-live-value project="103" variable="Temp_In"></ins-live-value>

<!-- With label and unit / Etiket ve birimle -->
<ins-live-value project="103" variable="Temp_In"
  unit="°C" label="Inlet Temperature" decimals="1">
</ins-live-value>

<!-- With color thresholds / Renk esikleriyle -->
<ins-live-value project="103" variable="Pressure"
  unit="bar" label="Pressure" decimals="2"
  thresholds="0:#2196F3,5:#4CAF50,8:#FF9800,10:#F44336">
</ins-live-value>

<!-- Multiple values on same page (single batch fetch) -->
<!-- Ayni sayfada birden fazla deger (tek toplu istek) -->
<ins-live-value project="103" variable="Temp_In" unit="°C" label="Giris" decimals="1"></ins-live-value>
<ins-live-value project="103" variable="Temp_Out" unit="°C" label="Cikis" decimals="1"></ins-live-value>
<ins-live-value project="103" variable="Flow_Rate" unit="m³/h" label="Debi" decimals="2"></ins-live-value>
```

---

## DataBus Configuration / DataBus Yapilandirmasi

**EN:** The DataBus is a singleton that manages all API communication. All components on the page share it automatically.

**TR:** DataBus, tum API iletisimini yoneten bir singleton'dir. Sayfadaki tum component'lar onu otomatik olarak paylasilir.

```js
// Change polling interval (default: 2000ms, min: 500ms)
// Polling araligini degistir (varsayilan: 2000ms, min: 500ms)
window.__insDataBus.refreshMs = 3000;

// Change space (default: "default_space")
// Space degistir (varsayilan: "default_space")
window.__insDataBus.space = "other_space";
```

---

## Full Custom Menu Example / Tam Custom Menu Ornegi

```html
<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <script src="https://cdn.jsdelivr.net/npm/@inscada/web-components/dist/ins-components.min.js"></script>
  <style>
    body { font-family: sans-serif; padding: 20px; }
    .card { display: inline-flex; flex-direction: column; align-items: center;
            padding: 16px 24px; margin: 8px; border-radius: 8px;
            background: #f5f5f5; box-shadow: 0 1px 3px rgba(0,0,0,0.12); }
    ins-live-value { font-size: 1.4em; }
  </style>
</head>
<body>
  <div class="card">
    <ins-live-value project="103" variable="Temp_In"
      unit="°C" label="Giris Sicakligi" decimals="1"
      thresholds="0:#2196F3,30:#4CAF50,60:#FF9800,80:#F44336">
    </ins-live-value>
  </div>
  <div class="card">
    <ins-live-value project="103" variable="Temp_Out"
      unit="°C" label="Cikis Sicakligi" decimals="1"
      thresholds="0:#2196F3,30:#4CAF50,60:#FF9800,80:#F44336">
    </ins-live-value>
  </div>
  <div class="card">
    <ins-live-value project="103" variable="Active_Power"
      unit="kW" label="Aktif Guc" decimals="0"
      thresholds="0:#4CAF50,500:#FF9800,800:#F44336">
    </ins-live-value>
  </div>
</body>
</html>
```

---

## Architecture / Mimari

- **DataBus** (singleton): All components on the page are fed by a single batch fetch / Sayfadaki tum component'lar tek bir toplu istek ile beslenir
- **Shadow DOM**: Each component is style-isolated / Her component stil olarak izole edilmistir
- **Zero dependency**: Vanilla JS + Web Components API only / Sadece saf JS + Web Components API
- **Auth**: `credentials: "include"` sends inSCADA session cookie automatically / inSCADA oturum cookie'sini otomatik gonderir
- **Batch optimization**: Components with the same `project` attribute share a single API call / Ayni `project` degerine sahip component'lar tek bir API cagrisi paylasilir

## License

MIT
