# Audiobook ingest — reference (zjištěno z existující knihovny)

Poznatky z analýzy `/mnt/p/My Audiobooks/` (115 knih, ~94 GB, stav k 2026-04-21).

## Struktura kořene

- **115 hlavních složek** s knihami ve formátu `Jméno Příjmení - Název`.
- **2 speciální kategorie**: `_Astronomie/`, `_Pohádky/` (jedno podtržítko = nahoře v řazení).
- **1 vstup**: `__raw/` (dvě podtržítka).

## Konvence názvů knih

### Prostý formát
- `Andy Weir - Marťan`
- `George Orwell - 1984`
- `Frank Herbert - Duna`
- `Terry Pratchett - Sekáč`

### Víc autorů
- `Vojtěch Matocha, Karel Osoha - Prašina` (čárka + mezera)

### Série bez číslování v názvu složky
- `Bernard Cornwell - Poslední království`
- `Bernard Cornwell - Bledý jezdec`
- `Frank Herbert - Duna` / `Spasitel Duny` / `Děti Duny` / `Božský imperátor Duny`

User série v názvu složky **neuvádí**. Série si řídí ručně přes pořadí v album tagu / přes ebook knihovnu.

### Výjimka — Příjmení first
- `Špitálníková Nina - Svědectví o životě v KLDR 2`

Je to anomálie (1 z 115), ne vzor k následování. U nových knih používej `Jméno Příjmení`.

## Soubory uvnitř knihy

### Vzorce pojmenování mp3

1. **Jen číslo**: `01.mp3`, `02.mp3` … (Andy Weir - Marťan, George Orwell - 1984)
2. **Číslo + název kapitoly**: `01 - Prolog.mp3`, `02 - Pondělí.mp3` (Robin Cook - Kóma)
3. **Číslo + kniha + část**: `01 - Kniha prvni - Duna, cast 1.mp3` (Frank Herbert - Duna — dvoudisková)
4. **Číslo + název** (bez pomlčky): `01 Černé slunce.mp3`, `02 Černé slunce.mp3` (Kožík)
5. **Název + číslo**: `Tři sekery 00.m4a`, `Tři sekery 01.m4a` (Surmanová)

Všechny tyto vzorce jsou v pořádku. **Nepřejmenovávat, pokud to není zjevně rozbité.**

### Přídavné soubory
- `cover.jpg` v adresáři — častý preview pro Finder / file manager.
- Občas `.m3u` playlisty (typicky od Surmanové) — při přijetí **smazat**.

### Formáty audia
- **mp3** (cca 95 %)
- **m4a** (občas, např. Tři sekery)
- **Nekonvertovat** mezi sebou — obě knihovna zpracuje.

## ID3 tagy — vzorec z knihovny

Z *Frank Herbert - Duna* (kompletní vzor):

```
TIT2: Kniha prvni - Duna, cast 1
TPE1: Frank Herbert
TRCK: 01
TALB: Duna
TPOS: 01/02
TDRC: 2016
TCON: Audiokniha
TCOM: Frank Herbert
TENC: Fraunhofer IIS MP3 v04.01.02 (high quality)
COMM: Interpreti: Marek Holy, Jana Strykova
APIC: (embedded JPEG cover)
```

### Minimum tagů pro každou stopu
- `TPE1` = autor
- `TALB` = název knihy
- `TIT2` = název kapitoly (nebo jen číslo)
- `TRCK` = číslo stopy
- `TCON` = `Audiokniha`
- `APIC` = obálka

### Volitelné, ale fajn
- `TDRC` = rok
- `TCOM` = autor (duplicita)
- `COMM` = "Čte: …" / "Interpreti: …"
- `TPOS` = disk (u víc-diskových)

## Typické pasti v `__raw/`

Z aktuálního stavu (10 položek k zpracování):

### 1. Vnořená struktura
```
__raw/
└── Gaiman & Pratchett - Dobrá znamení (audiokniha - čte Jan Zadražil)/
    └── Gaiman & Pratchett - Dobrá znamení - audiokniha - čte Jan Zadražil/
        └── 01.mp3, 02.mp3, ...
```

Řešení: vytáhnout obsah vnitřní složky nahoru, smazat prázdnou.

### 2. Archivy k rozbalení
```
__raw/Neil Gaiman - Američtí bohové/
├── CD1.7z
└── CD2.7z
```

Řešení: `7z x CD1.7z -o./`, `7z x CD2.7z -o./`, pak smazat archivy. Pokud `7z` chybí v systému → flag "potřebuje 7z", přeskočit.

### 3. Exotické názvy
- `Mluvene Slovo Neil Gaiman - Kniha hrbitova (2021)(CZ)` → `Neil Gaiman - Kniha hřbitova` (odstranit prefix, závorky, opravit diakritiku)
- `Mluvene Slovo Gaiman Neil - Nikdykde (Maedhros)(11h02m56s)` → `Neil Gaiman - Nikdykde` (prohodit Příjmení Jméno → Jméno Příjmení, odstranit závorky)

### 4. Playlist soubory
- `00 TŘI SEKERY.m3u` — smaž

### 5. cp1250→latin1 v tagách
- Robin Cook - Kóma → `COMM: Ète: Jiøí Klika` místo `COMM: Čte: Jiří Klika`
- Stejný pattern jako u ebooků, stejná mapa (`ø→ř, è→č, ì→ě, ù→ů`).

### 6. Dvojitá COMM
- Některé mp3 mají `COMM::eng:` i `COMM:ID3v1 Comment:eng:` s identickým obsahem. ID3v1 legacy — skill při rewritu jen `COMM::eng:` a smaže duplicitu.

## Zdroje obálek — co funguje

**databazeknih.cz** (primární, úspěšnost ~85 % na české knihy):
- Search `/search?q=<title>+<author>` → první výsledek je `<a href="/prehled-knihy/<slug>-<id>">`.
- Detail stránka obsahuje `<meta property="og:image" content="...">` s plnou cover URL.
- Pattern: `https://www.databazeknih.cz/img/books/<nn>_/<id>/<slug>-<hash>.jpg`.
- **Pitfall**: pro málo známé / nové knihy vrátí nerelevantní výsledek (viz `O čem skály mlčí` → scraper vrátil `O čem sní ženy`). Validuj slug proti názvu; pokud nesedí, vyhoď stažený soubor.

**Calibre `fetch-ebook-metadata`** (sekundární):
- Funguje dobře na populární světové tituly a klasiku.
- **Slabé** na české audioknihy — metadata někdy najde, ale cover plugin (Amazon, Goodreads) často nic.
- Užitečné pro doplnění metadata (rok, publisher, ISBN) i když cover selže.

**Manuální zdroje** (fallback):
- audiolibrix.cz — většinou má obálky audioknih, ale bez veřejného API.
- luxor.cz — knižní edice.
- Databáze knih mobile app má někdy jiné covery než web.

## Jazyky

- **ces** (čeština) — dominantní
- **eng** — Yuval Noah Harari - Sapiens (ENG) *(výjimka, v názvu je "(ENG)" pro rozlišení)*

U anglické knihy přidej `(ENG)` za název nebo jazykový tag v ID3 (`TLAN`).

## Kategorizační heuristika

Z `_Astronomie/` a `_Pohádky/`:

- `_Astronomie/` = aktuálně lekce astronomie (podle `01 - lekce Úvod.mp3`) — **ne** populárně-naučné knihy o vesmíru (ty jsou v kořeni: Harari, ...).
- `_Pohádky/` = dětská produkce (Vodnické pohádky).

Hranice je tenká — pokud nejistota, default **root**, user si případně přesune ručně.

## Commands cheat-sheet

```bash
# Rozbalit archiv
7z x CD1.7z -o./

# Číst tagy
python3 -c "from mutagen.id3 import ID3; id3=ID3('f.mp3'); [print(k,':',v) for k,v in id3.items()]"

# Obálka — primárně databazeknih.cz
python3 "$SKILL_DIR/scripts/fetch-cover-dbknih.py" --title "Název" --author "Autor" --out cover.jpg

# Fallback: Calibre (slabé pro audioknihy)
fetch-ebook-metadata --title "Název" --authors "Autor" --cover /tmp/cover.jpg

# Extrahovat embedded cover
python3 "$SKILL_DIR/scripts/extract-cover.py" "01.mp3" "cover.jpg"

# Embed cover do všech
python3 "$SKILL_DIR/scripts/embed-cover.py" --dir "book/" --cover "book/cover.jpg"

# Sjednotit tagy
python3 "$SKILL_DIR/scripts/fix-tags.py" --dir "book/" --author "Jméno Příjmení" --album "Název"

# Opravit cp1250
python3 "$SKILL_DIR/scripts/fix-comm-cp1250.py" --dir "book/"
```
