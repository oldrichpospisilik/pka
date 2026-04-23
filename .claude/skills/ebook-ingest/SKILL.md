---
name: ebook-ingest
description: Zpracuj syrové ebooky v /mnt/p/My Ebooks/_raw/ — konverze do EPUB, oprava metadat (title, authors, author-sort, language), stažení obálky, oprava textu (cp1250→latin1 garbled, NFC, krátké odstavce), přejmenování na "Příjmení, Jméno - [Série NN - ]Název.ext" a zařazení do Beletrie/ nebo Naučné/. Zápis do REORGANIZACE.md. Spouští uživatel zprávou jako "roztřiď ebooky", "zpracuj raw ebooky", "ebook ingest", "uklid ebooky", "roztřid knihovnu".
---

# ebook-ingest

Plně automatický skill na sanitizaci ebooků přidaných do `_raw/`. **Neptá se uživatele** — rozhodne se z metadat a kontextu, na konci vypíše souhrn.

## Primární cesty

| Účel | Cesta |
|---|---|
| Vstup (neroztříděné) | `/mnt/p/My Ebooks/_raw/` |
| Cíl — beletrie | `/mnt/p/My Ebooks/Beletrie/` |
| Cíl — naučné | `/mnt/p/My Ebooks/Naučné/` |
| Historie změn | `/mnt/p/My Ebooks/REORGANIZACE.md` (append) |
| Karanténa pro sporné | `/mnt/p/My Ebooks/_raw/_unsorted/` (vytvoř pokud neexistuje) |

**Nikdy nemanipuluj s knihovnou ve WSL (`~/My Ebooks/` nebo `~/My Ebooks - BACKUP/`)** — to je zastaralá kopie. Pracuj výhradně na pCloudu.

## Workflow (per soubor ve `_raw/`)

### 0. Předběžné kontroly

Před startem dávky:

1. **pCloud mount** — pokud `/mnt/p/` není dostupný, spusť `sudo mount /mnt/p` (sudoers pravidlo `/etc/sudoers.d/pcloud` funguje bez hesla). Pokud selže, řekni uživateli ať spustí pCloud aplikaci ve Windows a zkus znovu.
2. **Dependency check** — ověř `which ebook-convert ebook-meta fetch-ebook-metadata`. Pokud kterýkoli chybí, vypiš uživateli jak instalovat Calibre (`apt install calibre` ve WSL, nebo stažení z calibre-ebook.com) a skonči.
3. **Spočítej soubory** v `_raw/` (bez `_unsorted/`), ohlaš plán ("zpracuju N souborů"), pak začni.
4. **Ignoruj systémové soubory** — `.DS_Store`, `Thumbs.db`, `.apnx`, `.opf`, `.mbp1`, `.mbs`, `.sdr`. Smaž je (tiché úklidové operace, patří k sanitizaci z REORGANIZACE.md bodu 2).

### 1. Identifikace formátu

Dle přípony (case-insensitive): `epub`, `pdf`, `mobi`, `azw`, `azw3`, `pdb`, `lrf`, `txt`, `rtf`, `fb2`, `htmlz`.

**Priorita formátů**: EPUB > MOBI > AZW > PDB > LRF > PDF.

**PDF ponechej jako PDF** (konverze by zhoršila kvalitu).

### 2. Konverze na EPUB

Pokud soubor není EPUB ani PDF:

```bash
ebook-convert "input.mobi" "output.epub"
```

Pro PDB v kódování cp1250 (častá historická past u českých knih):

```bash
ebook-convert "input.pdb" "output.epub" --input-encoding cp1250
```

Detekce cp1250: u českých autorů (jména v názvu souboru — Čech, Cook kdysi česky, Kulhánek, Kotleta, Žamboch, Forward překlad apod.) výchozí `--input-encoding cp1250`, jinak default.

Po úspěšné konverzi **originál smaž** (už máme EPUB).

### 3. Extrakce metadat

```bash
ebook-meta "kniha.epub"
```

Parsuj výstup: Title, Author(s), Language, Tags, Published.

**Problémové vzorce**, které vyžadují doplnění:
- Title = `index`, `unknown`, empty, nebo to je název souboru bez diakritiky.
- Author = `Unknown`, `Calibre` nebo empty.
- Language = `eng` u zjevně české knihy (rozpoznáš z názvu/autora).

### 4. Rozpoznání autora a názvu

Prioritní zdroje:
1. Interní metadata (pokud vypadají rozumně).
2. Název souboru — užitné vzorce: `Příjmení, Jméno - Název`, `Příjmení-Jméno---Název`, `Název - Příjmení, Jméno`, `Autor - Série NN - Název`.
3. Když název souboru je chaos (`CookBook Web 2020.pdf`, `index.mobi`) → `fetch-ebook-metadata` podle obsahu souboru:
   ```bash
   fetch-ebook-metadata --opf "kniha.epub"
   ```

**Série** — pokud název obsahuje číslo a možnou sérii (`Zaklínač 01`, `Nadace 02`), použij formát `Série NN - Název` (dvoumístné číslo).

### 5. Oprava metadat

```bash
ebook-meta "kniha.epub" \
  --title "Správný název s diakritikou" \
  --authors "Jméno Příjmení" \
  --author-sort "Příjmení, Jméno" \
  --language ces
```

Jazykové kódy: `ces` (čeština), `slk` (slovenština), `eng`, `ger`, `fre`, atd. Pokud jazyk z názvu/autora nejasný → default `ces` pro české autory, `eng` jinak.

### 6. Stažení obálky

```bash
fetch-ebook-metadata --title "název" --authors "autor" --cover /tmp/cover.jpg
```

Pokud úspěch:
```bash
ebook-meta "kniha.epub" --cover /tmp/cover.jpg
rm /tmp/cover.jpg
```

Pokud selže českým názvem → zkus anglický (je-li dostupný). Pokud stále selže → pokračuj bez obálky (není blocking).

### 7. Kontrola kvality textu

Spouštěj jen na `.epub` (ne `.pdf`). Pomocné skripty jsou v `scripts/`.

**a) Rozbité kódování cp1250→latin1**:

Detekce: v textu HTML souborů uvnitř EPUB hledej znaky `ø, è, ì, ù, ð, ï, ò` v českém kontextu. Pokud > 20 výskytů, spusť opravu:

```bash
python3 "$SKILL_DIR/scripts/fix-cp1250.py" "kniha.epub"
```

**b) Combining accents (NFD → NFC)**:

Detekce: hledej `ı` (dotless i, U+0131) + combining acute (U+0301). Pokud najdeš byť jednou, spusť:

```bash
python3 "$SKILL_DIR/scripts/nfc-normalize.py" "kniha.epub"
```

**c) Rozbité odstavce**:

Detekce: spočítej procento odstavců kratších než 80 znaků. Pokud > 80 % a kniha není poezie/drama (heuristika z metadat nebo názvu: `R.U.R.`, `Hamlet`, atd. přeskoč), spusť:

```bash
python3 "$SKILL_DIR/scripts/merge-paragraphs.py" "kniha.epub"
```

### 8. Přejmenování

Finální formát:

```
Příjmení, Jméno - [Série NN - ]Název.epub
```

**Pravidla**:
- Česká diakritika v názvech **zachovat** (pCloud i Obsidian s ní umí).
- Pokud více autorů → `Příjmení1, Jméno1; Příjmení2, Jméno2 - Název.epub`.
- Znaky, které by rozbily filesystem (`/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`) → nahradit pomlčkou nebo smazat.
- Úvodní/koncové mezery odstranit.

### 9. Zařazení do kategorie

**Automatické rozhodnutí** (bez ptaní):

1. **Beletrie**, pokud:
   - Metadata mají tag/genre: fiction, novel, sci-fi, fantasy, detective, thriller, romance, horror, young-adult.
   - Autor je známý beletrista (Asimov, King, Martin, Sapkowski, Pratchett, Orwell, Cook Robin, Kulhánek, Žamboch, Kotleta, Kulhánek, Douglas Penelope atd.).
   - Název signalizuje beletrii.
2. **Naučné**, pokud:
   - Metadata tag: non-fiction, science, philosophy, history, biography, self-help, textbook, cookbook, guide, programming, business, psychology.
   - Název obsahuje klíčová slova: `průvodce`, `učebnice`, `encyklopedie`, `jak`, `principy`, `dějiny`, `fyzika`, `matematika`, `programování`, `design`, `ekonomie`, `filozofie`, `recepty`, `kuchařka`, `history`, `science`, `manual`, `guide`, `textbook`, `handbook`.
   - Životopisy a paměti.
3. **Nejistota** → přesuň do `_raw/_unsorted/` a v reportu flagni jako "k ruční kontrole". **Nikdy nemaž** originál.

Pro známé autory / názvy použij svoji obecnou znalost — nepotřebuješ k tomu externí databázi. Pokud nevíš → `_unsorted/`.

### 10. Přesun

```bash
mv "kniha.epub" "/mnt/p/My Ebooks/<Beletrie|Naučné>/Příjmení, Jméno - Název.epub"
```

Pokud cílový soubor už existuje:
- Porovnej velikosti / hash. Pokud identický → smaž nový (je to duplicita).
- Pokud jiný → přejmenuj nový na `...(kopie).epub` a flagni pro ruční kontrolu.

### 11. Zápis do REORGANIZACE.md

**Append** záznam dávky. Formát (dodržuj styl už existujících záznamů):

```markdown
## YYYY-MM-DD: Ingest z _raw (N knih)

| Soubor | Autor | Název | Kategorie | Poznámka |
|--------|-------|-------|-----------|----------|
| původní-jméno.mobi | Jméno Příjmení | Název | Beletrie | konverze z MOBI, metadata doplněna, obálka ano |
| ... | ... | ... | ... | ... |

**Problémové** (k ruční kontrole v `_unsorted/`):
- `soubor.pdf` — neznámý autor, název je `index`
```

## Report na konci dávky

Formát v chatu:

```
Zpracováno: X souborů
├── Beletrie: N (seznam)
├── Naučné: M (seznam)
└── _unsorted/: K (seznam + důvod)

Opravy textu:
- cp1250 fix: N knih
- NFC normalize: M knih
- Paragraph merge: P knih

Dependency status: OK / chybí [nástroj]
REORGANIZACE.md: aktualizováno
```

## Bezpečnostní pravidla

- **Nikdy nemaž** z Beletrie/ nebo Naučné/ (tam žijí zpracované knihy — jen tam přidávej).
- **Nepřepisuj** existující soubor ve cílové složce bez kontroly duplicity.
- **Originál ze _raw/** smaž až po **úspěšné** konverzi + přesunu. Při chybě nech originál na místě.
- PII a zdravotní obsah — pokud v metadatech detekuješ osobní údaje (ISBN + identifikátor čtenáře, email, telefon), přesuň do `_unsorted/` a flagni — nepřidávej do Beletrie/Naučné.

## Testování při prvním spuštění

Pokud je `_raw/` prázdný, vypiš stav a skonči (není na co reagovat).

Pokud obsahuje 1 soubor, použij ho jako dry-run: vypiš navrhované kroky (co by se udělalo) **před** jejich provedením a počkej na potvrzení uživatele. Teprve od 2+ souborů jedeš plně automaticky bez konfirmace — uživatel už skillu věří.

## Reference

- `REFERENCE.md` — historie problémů z jarního úklidu 2026 (548 souborů → 170), lessons learned pro specifické knihy.
- Původní pokyny: `/mnt/p/My Ebooks/CLAUDE.md` (stejný obsah, slouží jako on-disk dokumentace mimo tento skill).
