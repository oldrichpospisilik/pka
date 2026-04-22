# Ebook ingest — reference a lessons learned

Shrnutí poznatků z velkého úklidu knihovny v únoru 2026 (548 syrových souborů → 170 sanitovaných). Pro skill je tohle pomocná znalost: _vzorce problémů, které se v reálné knihovně opakovaly_, aby na ně skill uměl reagovat.

## Formáty, které se potkáváme

| Formát | Poznámka |
|---|---|
| **EPUB** | Hlavní cíl. ZIP archiv s HTML/XHTML + metadata. |
| **PDF** | Ponechat tak jak je — konverze degraduje kvalitu. |
| **MOBI** | Konverze OK, většina bez problémů. |
| **AZW / AZW3** | Amazon Kindle formáty; konverze OK. |
| **PDB** | Palm Digital Media, historicky plný cp1250 pastí. **Vždy zkus `--input-encoding cp1250`** u českých. |
| **LRF** | Sony Reader, konverze OK ale formát mrtvý. |
| **FB2 / HTMLZ / TXT / RTF** | Okrajové, konverze typicky OK. |

## Metadata zbytky ke smazání

- `.apnx` (Amazon page index)
- `.opf` (Calibre metadata XML)
- `.mbp1` (Kindle záložky)
- `.mbs` (Kindle anotace)
- `.sdr/` (Kindle reading data — složka)
- `cover.jpg` v podsložkách knih

Všechny tyhle soubory se dají smazat při úklidu — nepatří do knihovny.

## Priorita při duplicitách

Když existuje ta samá kniha ve více formátech, nech jen jednu:

**EPUB > MOBI > AZW > PDB > LRF > PDF**

Příklady rozhodnutí z historie:
- `japan_by_rail_v5` — EPUB + PDF → zůstal EPUB.
- `Vzhůru do CSS3` — v1.3 + v1.4 v několika formátech → zůstala jen v1.4 EPUB (novější verze).
- `Web ostrý jako břitva` — 217-stránkový split-page PDF + EPUB + MOBI → zůstal jen EPUB.

## Textové problémy — diagnostika a řešení

### 1. Rozbitné kódování cp1250 ↔ latin1

**Jak to poznáš**: v českém textu vidíš `ø, è, ì, ù, ð, ï, ò, ¾, ®` místo `ř, č, ě, ů, ď, ï, ň, ž, Ž`.

**Příklad "před"**:
```
"A? u? se to jmenuje jak chce"
"opìt pøitiskl oèi"
```

**Po opravě**:
```
"Ať už se to jmenuje jak chce"
"opět přitiskl oči"
```

**Řešení A (zdroj dostupný)**: znovu převést z původního PDB/MOBI s `ebook-convert input.pdb output.epub --input-encoding cp1250`.

**Řešení B (EPUB už vyrobený)**: `scripts/fix-cp1250.py` — přepíše HTML soubory uvnitř EPUB a zabalí zpátky se správnou `mimetype` (ZIP_STORED).

**Historicky opraveno** (8 knih): Cook Robin (5×), Forward Robert L (3×), Minier Bernard "Mráz", Nesbø Jo "Syn", Merle Robert "Malevil".

### 2. Combining accents (NFD → NFC)

**Jak to poznáš**: znaky vypadají správně, ale hledání v textu nenajde `Praha` protože `P` je `P` a `r` je `r`, ale `a` je ve skutečnosti `ı` (dotless-i, U+0131) + combining acute (U+0301). Časté u knih s OCR-generovanou diakritikou.

**Řešení**: `scripts/nfc-normalize.py` — `unicodedata.normalize("NFC", text)` + nahradit `ı` → `i`.

**Historicky opraveno**: *Japan by Rail* (~1 079 combining chars).

### 3. Rozbité odstavce

**Jak to poznáš**: > 80 % odstavců kratších než 80 znaků (každý řádek vlastní `<p>`), případně slova rozdělena pomlčkou na konci řádku (`slovo-` `</p><p>` `pokračování`).

**Kdy to nefixovat**:
- Poezie (sbírky, Morgenstern, haiku).
- Drama (R.U.R., Hamlet, Macbeth) — krátké repliky jsou správně.
- Obsah v obrázcích/SVG (např. Ludwig — Konec prokrastinace).

**Řešení**: `scripts/merge-paragraphs.py` — sloučí `<p>`, kde předchozí nekončí `.!?:;` a následující začíná malým písmenem. Taky glue split words.

**Historicky opraveno**:
- Kulhánek — *Noční klub 02* (5 603 odstavců sloučeno, 5 hyphenů).
- Kulhánek — *Stroncium* (6 855 / 40).
- Martin — *Bouře mečů 1* (6 266 / 24).
- Isaacson — *Steve Jobs* (— / 121).

## Autoři a jejich zvláštnosti

- **Česká sci-fi/fantasy** (Kulhánek, Kotleta, Žamboch, Sapkowski) — většinou fanouškovské digitalizace PDB → cp1250 problémy časté.
- **Cook Robin** — český překlad z 90. let, většinou v PDB s cp1250.
- **Forward Robert L** — 3 knihy "Saturnsky Ruchch" typ chaosu v názvech souborů, všechny cp1250.
- **Martin G.R.R.** — originál EPUB obvykle OK, ale některé fanouškovské verze mají rozbité odstavce.
- **Pratchett Terry** — Zeměplocha, série 01–41, číslovat dvojmístně.
- **Sapkowski Andrzej** — Zaklínač série (povídky, saga, Věděnský saga), číslovat dvojmístně.

## Jazykové kódy (ISO 639-2)

| Kód | Jazyk |
|---|---|
| `ces` | čeština |
| `slk` | slovenština |
| `eng` | angličtina |
| `ger` | němčina |
| `fre` | francouzština |
| `pol` | polština |
| `rus` | ruština |
| `spa` | španělština |

## Commands cheat-sheet

```bash
# Konverze
ebook-convert "input.mobi" "output.epub"
ebook-convert "input.pdb" "output.epub" --input-encoding cp1250

# Čtení metadat
ebook-meta "kniha.epub"

# Zápis metadat
ebook-meta "kniha.epub" \
  --title "Název" \
  --authors "Jméno Příjmení" \
  --author-sort "Příjmení, Jméno" \
  --language ces

# Stažení metadat + obálky
fetch-ebook-metadata --title "název" --authors "autor" --cover /tmp/cover.jpg --opf

# Vložit obálku
ebook-meta "kniha.epub" --cover /tmp/cover.jpg
```

## Výsledné cíle knihovny

- **Jednotné pojmenování**: `Příjmení, Jméno - [Série NN - ]Název.epub` s českou diakritikou.
- **Správná interní metadata**: title (s diakritikou), authors, author-sort, language.
- **Obálka** u každé knihy, pokud lze dohledat.
- **Čistý text** — bez cp1250 garbled, bez NFD combining, bez rozbitných odstavců (u prózy).
- **Kompatibilita** s PocketBook, Kobo, Calibre.
