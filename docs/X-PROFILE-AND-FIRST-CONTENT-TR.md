# X Profili ve İlk İçerikler

Hazırlanma: 14 Ağustos 2026 · Hesap: `@emredogancloud` · 23 takipçi · bio boş

Bu dosyadaki **açıklamalar Türkçe**, **kopyalanacak içerikler İngilizce**. Sebebi
[X-BUYUME-VE-HESAP-BASLANGIC-SISTEMI-TR.html](./X-BUYUME-VE-HESAP-BASLANGIC-SISTEMI-TR.html)
Bölüm B'de: dağıtım takipçi havuzunda başlıyor, hedef kitlen global.

---

## 1. Avatar — `MyFeature.png` değerlendirmesi

İncelenen görsel: koyu gri arka planda, siyah gömlekli, koyu saçlı genç bir erkeğin
önden stüdyo portresi.

### Karar: **BU HALİYLE KULLANMA**

İki ayrı sebep var ve ikincisi birincisinden çok daha önemli.

**a) Teknik sorun — küçük boyutta okunmuyor.**
X avatarı zaman akışında ~40px görünür. Bu görselde koyu saç + siyah gömlek + koyu gri
arka plan var; üç ton da birbirine yakın. 40px'e indiğinde yüz hatları kayboluyor,
geriye koyu bir leke kalıyor. Avatarın tek işi **küçükken tanınmak**.

**b) Asıl sorun — bu fotoğraf gerçekten sen misin?**
Görselde yapay üretim işaretleri var: tek tip cilt dokusu, kusursuz simetri, saç
sınırlarının hafif eriyik görünmesi, sensör gürültüsünün hiç olmaması. Ayrıca dosya
`~/Pictures/xxx/` içinde, yanında epoch adlı (`1762841923843.jpg`) onlarca üretilmiş
dosya var.

**Kesin olarak bilemem — bu yüzden kararı sana bırakan bir kural veriyorum:**

| Durum                      | Karar                                                                      |
| -------------------------- | -------------------------------------------------------------------------- |
| Bu senin gerçek fotoğrafın | Kullanılabilir, ama **aydınlık arka plan + açık renk üst** ile yeniden çek |
| Bu yapay üretim bir yüz    | **Kesinlikle kullanma**                                                    |

İkinci durumda neden bu kadar keskin: bu hesabın tüm konumlandırması
_"ben test ederim, doğrusunu söylerim"_. Yapay üretilmiş bir yüzü kendi yüzün gibi
kullanmak, tek bir kişi fark ettiğinde o konumlandırmanın tamamını çökertir. Kazanç
küçük, kayıp geri alınamaz. Ayrıca §C'deki `agatha/` hatırlatması: hesap seviyesi
etiketler _başkalarının tepkisinden_ üretiliyor.

**Önerilen avatar:** gerçek portre, açık/nötr arka plan, üstte koyu olmayan bir renk,
omuz hizasından kadraj, yüz karenin ~60'ını kaplasın. Telefonla çekilmiş iyi ışıklı bir
fotoğraf, stüdyo işi olmayan ama gerçek olan bir fotoğraf, üretilmiş mükemmel bir
portreden her zaman daha iyi çalışır.

---

## 2. Kullanıcı adı ve görünen ad

### Handle: `@emredogancloud` — **ŞİMDİLİK DEĞİŞTİRME**

Gerekçe:

- **"cloud" gerçekten dar.** Yaptığın iş Flutter + Supabase + Anthropic ile mobil ve AI
  uygulaması geliştirmek; "cloud" yanlış bir vaat veriyor.
- **Ama handle değişikliğinin bedeli şu an düşük, faydası da düşük.** 23 takipçin var,
  yani "eski handle'ın değeri" diye bir şey yok. Buna karşılık handle değiştirmek
  mevcut linklerini ve `emredogan.work` üzerindeki referansları kırar.
- **Görünen ad zaten aramada ve önerilerde görünüyor** ve onu bedelsiz değiştirebilirsin.

**Öneri:** önce görünen adı ve bio'yu düzelt, 30 gün içerik üret, handle kararını
o zaman ver. Değiştirmeye karar verirsen `@emredogandev` veya `@emredoganbuilds`
yönünde bak — **ama müsaitliklerini doğrulamadım, kimse doğrulamadan söz vermemeli.**

### Görünen ad — kopyala

```
Emre Doğan · AI apps
```

Alternatif:

```
Emre Doğan — builds AI apps
```

Neden: ad alanı aranabilir. Boş bırakmak ücretsiz bir sinyali harcamak.

---

## 3. Bio

Üç aday. Hepsi İngilizce, hepsi üç soruya cevap veriyor: ne inşa ediyorum, neyle,
burada ne paylaşacağım.

### Aday A — önerilen

```
I build AI-powered mobile apps solo. Flutter + Supabase + Anthropic.
I test the models I write about, and post what actually changed.
Shipping to the App Store & Play Store · emredogan.work
```

### Aday B — daha kısa

```
Solo builder. AI apps with Flutter + Supabase + Anthropic.
I test models before I have opinions about them.
emredogan.work
```

### Aday C — daha teknik

```
Building AI apps end to end: on-device ML, Anthropic-backed features, Supabase edge.
I publish what I measured, not what was announced.
emredogan.work
```

**Neden bunlar işe yarıyor:** üçü de _ne yaptığını_ söylüyor, _nasıl_ olduğunu somut
teknolojiyle destekliyor ve takip etme sebebini açıkça veriyor. Hiçbirinde
"passionate about AI", "AI enthusiast", "helping people" gibi bilgi taşımayan ifade yok.

**Kullanma:** "AI enthusiast", "tech lover", "building the future", "10x developer",
sahip olmadığın bir unvan, doğrulanamayan bir başarı.

---

## 4. Banner — 5 konsept

Banner ölçüsü: **1500 × 500 px (3:1)**. Profil fotoğrafı sol altta banner'ı kapatır,
bu yüzden **sol alt köşeye hiçbir şey koyma**.

---

### Konsept 1 — "Gerçek ürün" (en güçlü seçenek)

**Neden uyuyor:** kanıt taşır. Diğer dördü tasarımdır; bu, yaptığın şeyin kendisidir.

**Görsel yön:** FormAI'ın gerçek ekranlarından 2–3 tanesi, hafif açılı, koyu zeminde
yan yana. Üretilmiş görsel değil, **gerçek ekran görüntüsü**.

**GPT Image promptu gerekmez** — bunu kendin hazırlayacaksın:

```
1. FormAI'dan 3 ekran görüntüsü al (pose analiz ekranı, food scan sonucu, koç sohbeti)
2. 1500x500 koyu zemin (#0b0d12) üzerine hafif perspektifle yerleştir
3. Sağ üste tek satır: "AI apps, built solo — Flutter · Supabase · Anthropic"
4. Sol alt %25'i boş bırak (avatar oraya gelecek)
```

**Metin:** `AI apps, built solo — Flutter · Supabase · Anthropic`
**Koyma:** sahte metrik, "10k users", uydurma grafik.

---

### Konsept 2 — "Terminal + cihaz"

**Neden uyuyor:** geliştirici kimliğini anında kurar, klişe değildir.

```
A wide 3:1 editorial technology banner. Left two-thirds: a dark code editor
window at a slight angle, showing clean Dart/Flutter source with visible
indentation, out of focus at the edges. Right third: a modern smartphone
standing upright, screen glowing softly, showing an abstract app interface with
simple cards — no readable text on the phone. Background: near-black (#0b0d12)
with a very subtle cool gradient. Lighting: soft, from the upper left, single
source. Style: calm, editorial, high-end developer publication. Sharp focus on
the phone, shallow depth of field elsewhere. Aspect ratio 3:1.

Must NOT contain: any company logo or wordmark, any readable UI text, any
statistics or numbers, robot imagery, glowing neural-network graphics, circuit
board patterns, cyberpunk neon, any human face, any lens flare.
```

**Metin:** yok (görsel yeterince konuşuyor)

---

### Konsept 3 — "Ölçüm masası"

**Neden uyuyor:** "test ederim" iddiasını görselleştirir — konumlandırmanın kalbi.

```
A wide 3:1 editorial photograph of a minimal developer desk shot from directly
above. On the surface: a laptop showing a simple dark chart with two plain bars,
a phone lying flat, a paper notebook with handwritten notes, a pen, a cup of
black coffee. Muted colour palette, near-black desk surface, warm neutral
lighting from one side, deep soft shadows. Calm, precise, unstyled — like a
working desk rather than a product photo. Aspect ratio 3:1, generous empty space
in the lower left quarter.

Must NOT contain: any logo, any readable text, any brand, decorative gadgets,
plants, neon, RGB lighting, a human face or hands, stock-photo styling.
```

**Metin:** sağ üst köşeye `I test the models I write about.`

---

### Konsept 4 — "Öncesi / sonrası"

**Neden uyuyor:** paylaşacağın içeriğin formatını banner'a taşır.

```
A wide 3:1 minimal technical diagram on a near-black background (#0b0d12).
Two labelled panels side by side, separated by a thin vertical line. Left panel
label: "BEFORE". Right panel label: "AFTER". Inside each panel, a simple abstract
geometric representation of a data flow made of thin lines and small squares —
denser and tangled on the left, sparse and ordered on the right. One single
restrained accent colour (muted blue) used only on the right panel. Typography:
one clean geometric sans-serif, small, high contrast. Generous negative space.
Aspect ratio 3:1, nothing in the lower left quarter.

Must NOT contain: any logo, any number or percentage, any additional text beyond
the two labels, gradients, glow effects, 3D rendering, a human figure.
```

**Metin:** panel etiketleri dışında yok

---

### Konsept 5 — "Katmanlar"

**Neden uyuyor:** uçtan uca inşa ettiğini anlatır (cihaz → edge → model).

```
A wide 3:1 abstract editorial illustration on a near-black background. Three
horizontal layers stacked with clear vertical separation, connected by thin
vertical lines. Top layer: a simple outlined phone shape. Middle layer: three
small rounded rectangles suggesting services. Bottom layer: a wide flat slab
suggesting a model. Everything drawn in thin monochrome lines except one muted
blue accent on the connecting lines. Extremely restrained, technical-diagram
aesthetic, lots of empty space. Aspect ratio 3:1, lower left quarter empty.

Must NOT contain: any logo, any text or label, any brain imagery, any robot,
any glow, any network-of-dots cliché, any gradient background.
```

**Metin:** sağ üst `device → edge → model`

---

## 5. Sabitlenmiş gönderi

Bu **günün tweet'i değil**. Bu, profilini açan birinin okuyacağı kalıcı cevap:
_"bu hesabı takip edersem ne kazanırım?"_

Liste değil, anlatı olmalı. Aşağıdaki sadece **gerçekten yaptığın** şeyleri içeriyor.

### Kopyala — sabitlenmiş gönderi

```
I build AI-powered mobile apps on my own — currently a fitness app with
on-device pose analysis and an Anthropic-backed food scanner.

Flutter, Supabase edge functions, Claude. Shipped to the stores, not a demo.

Here I post what I find while building: model releases I actually tested,
release notes nobody read, and the difference between what was announced and
what changed.

Occasionally books on Amazon KDP. Projects: emredogan.work
```

**Karakter:** ~430 (thread değil, tek gönderi olarak uzun — X Premium ile sorun yok;
Premium yoksa aşağıdaki kısa sürümü kullan)

### Kısa alternatif (280 altı)

```
I build AI apps solo — Flutter, Supabase, Claude. Currently a fitness app with
on-device pose analysis and an Anthropic-backed food scanner, shipped to the
stores.

Here: models I actually tested, and what release notes don't say.

emredogan.work
```

### Önerilen medya

FormAI'dan **gerçek ekran görüntüsü** — tercihen pose analiz ekranı, çünkü cihaz üstünde
çalışan bir şey olduğunu tek bakışta gösteriyor. Yapay üretilmiş görsel kullanma;
sabitlenmiş gönderinin işi güven kurmak.

> **Uyarı — asla yazma:** kullanıcı sayısı, gelir, "thousands of downloads",
> yapılmamış test, video analizi özelliği (`lib/features/video_analysis/` bağlı
> değil — demo etme, ima etme).

---

## 6. Bugünün ilk ciddi gönderisi

### Olay

**xAI, For You algoritmasının yeni sürümünü 13 Ağustos 2026'da yayınladı.**
`pushed_at 2026-08-13T17:23:57Z`, 300 dosya, GitHub API ile doğrulandı.

### Bu olay neden

Alternatifleri gerçekten değerlendirdim. Bugün panelde en yüksek skorlu olaylar
SDK sürümleri ve canary release'ler — teknik olarak gerçek ama **kimseyi ilgilendirmez**
ve yeni bir hesabın ağ dışı vergisini ödemeye yetmez.

Bu olay dört şeyi aynı anda sağlıyor:

1. **Taze ve doğrulanabilir** — dün, tek komutla teyit edilebilir.
2. **Kimse yazmadı** — özellikle eklenen `abuse-enforcement-service/` kuralları.
3. **Konumlandırmanla birebir** — "release notes'ta kimsenin okumadığı şey".
4. **Orijinal katkı gerektiriyor ve sende var** — kuralları okudun.

### Açı

"Algoritma güncellendi" demek değersiz; onu büyük hesaplar zaten yazacak. Senin açın
**kuralların içindeki somut şey**: yayınlanan `enforcement_post.yaml` dosyasında
`llm_slop_post` sınıflandırıcısı gönderiye 30 gün süreli `RiskyHighVizReply` etiketi
koyuyor — ve aynı dosya `high_follower_count` ile başlıyor, yani büyük hesaplar bu
kontrolden **atlanıyor**.

### Kopyala — İngilizce gönderi

```
xAI pushed a new X algorithm drop yesterday — 300 files, and the enforcement side is public for the first time.

enforcement_post.yaml: an llm_slop_post classifier labels a post RiskyHighVizReply for 30 days.

The same file opens with: skip if follower count is high.
```

**Karakter: 267 / 280** — sayıldı, tahmin edilmedi. Link yok — hem ağ dışı dağıtımda dezavantaj hem de API'de
13 kat pahalı (bkz. rapor §J).

### Kaynak

`https://github.com/xai-org/x-algorithm` →
`abuse-enforcement-service/service-lib/rules/enforcement_post.yaml`

### Medya

**EVET — ekran görüntüsü.**

- **Ne gösterilecek:** `enforcement_post.yaml` dosyasının `act_add_llm_slop_post_label`
  bloğu, GitHub arayüzünde, `ttl_msec: 2592000000` satırı görünür halde.
- **Nereden:** doğrudan GitHub'dan.
- **Nasıl:** dosyayı aç, ilgili 8 satırı kırp, 2× ölçekte ekran görüntüsü al.
- **Neden:** iddiayı iddia olmaktan çıkarır. Bu gönderinin tüm gücü "kodu ben okudum"
  olmasında; ekran görüntüsü bunu kanıtlar.

GPT Image promptu **gerekmiyor** — üretilmiş görsel burada zarar verir, çünkü gönderinin
iddiası birincil kaynağı okumuş olman.

### Quote / reply / bağımsız?

**Bağımsız gönderi.** Alıntılayacak bir duyuru yok (xAI bunu duyurmadı, sadece push
etti — haber değeri de tam olarak bu). Reply de yanlış: cevap verilecek bir konuşma
henüz oluşmadı.

### Neden bu doğru ilk ciddi gönderi

Yeni bir hesabın ağ dışına çıkmasının tek yolu, ağ dışı çarpanını yenecek kadar iyi
olmak. Bunu sağlayan şey **kimsenin sahip olmadığı bilgi**. 23 takipçiyle atılan
"GPT-5 çıktı" gönderisi 30 görüntülenme alır; "dün yayınlanan enforcement kurallarında
şu var" gönderisi, konuyla ilgilenen küçük ama doğru kitleye ulaşma şansına sahiptir.

**Bugün sadece bunu at.** Aynı gün ikinci bir gönderi
(`author_diversity_scorer`) ilkinin dağıtımını yer.

---

## 7. emredogan.work — teşhis

### Bu bir Cloudflare sorunu değil

```
$ dig +short emredogan.work NS
verify-contact-details.namecheap.com.
failed-whois-verification.namecheap.com.

$ dig +short emredogan.work A
198.54.117.242
```

**Alan adı, WHOIS doğrulaması yapılmadığı için Namecheap tarafından askıya alınmış.**
Nameserver'lar Cloudflare'e değil, Namecheap'in askı sunucularına işaret ediyor;
`198.54.117.242` Namecheap'in park sayfası. HTTPS isteği de yanıtsız kalıyor.

Bu ICANN zorunluluğu: kayıt/iletişim bilgisi değiştiğinde registrant e-postasını
15 gün içinde doğrulaman gerekir, yoksa alan adı askıya alınır.

### Çözüm — DNS'e dokunma

1. Namecheap hesabına gir → **Domain List** → `emredogan.work`
2. Kırmızı uyarıyı bul: _"Verify your contact details"_ / _"WHOIS verification"_
3. **Resend verification email** → gelen e-postadaki bağlantıya tıkla
4. Spam klasörünü kontrol et; e-posta `verification@namecheap.com` benzeri bir
   adresten gelir
5. Doğrulama sonrası nameserver'lar normale döner (yayılma birkaç saat)

### Doğrulama komutları

```bash
dig +short emredogan.work NS        # namecheap askı sunucuları GİTMELİ
dig +short emredogan.work A         # gerçek origin IP'n görünmeli
curl -sI https://emredogan.work     # HTTP 200 dönmeli
```

### Beklenen son durum

NS kayıtları senin gerçek DNS sağlayıcına (Cloudflare kullanacaksan
`*.ns.cloudflare.com`) işaret eder, A/CNAME origin'e gider, HTTPS yanıt verir.

> **Cloudflare'i şimdi kurma.** Alan adı askıdayken Cloudflare'e taşımak işe yaramaz;
> önce askıyı kaldır, sonra istersen Cloudflare'e geç.

---

## 8. Uygulama sırası

| #   | İş                                             | Süre  |
| --- | ---------------------------------------------- | ----- |
| 1   | Namecheap WHOIS doğrulaması (site geri gelsin) | 5 dk  |
| 2   | Görünen ad + bio                               | 5 dk  |
| 3   | Avatar (gerçek fotoğraf, açık arka plan)       | 15 dk |
| 4   | Banner (Konsept 1 önerilir)                    | 30 dk |
| 5   | Sabitlenmiş gönderi + FormAI ekran görüntüsü   | 15 dk |
| 6   | Bugünün gönderisi + kod ekran görüntüsü        | 15 dk |

1–5 bitmeden 6'yı yapma. Profil dönüşmüyorsa gelen trafiği harcarsın.
