"""
Hourly stock updater for GitHub Actions.
Uses /report/stock/all?filter=stockMode=positiveOnly — only products actually in stock.
Downloads images to img/ folder — served directly via GitHub Pages.
Caches existing images to avoid re-downloading every run.
"""
import requests, json, os, time
from collections import defaultdict

MS_TOKEN = '3b701e01c5660188053b898da86779c282b1c527'
HEADERS = {'Authorization': f'Bearer {MS_TOKEN}', 'Accept': 'application/json;charset=utf-8'}
BASE = 'https://api.moysklad.ru/api/remap/1.2'
os.makedirs('img', exist_ok=True)

def ms_get(url, timeout=90, retries=4):
    """GET с ретраями — MoySklad API иногда таймаутит."""
    last = None
    for i in range(retries):
        try:
            return requests.get(url, headers=HEADERS, timeout=timeout)
        except requests.exceptions.RequestException as e:
            last = e
            wait = 2 ** i
            print(f'  ⚠️  {e.__class__.__name__}: ретрай через {wait}с (попытка {i+1}/{retries})')
            time.sleep(wait)
    raise last

BRANDS = [
    'Nike','Adidas','New Balance','Puma','Converse','Vans','The North Face',
    'Tommy Hilfiger','Calvin Klein','Ralph Lauren','Hugo Boss','Lacoste','Fred Perry',
    'Gant','Weekend Offender','Columbia','Helly Hansen','Under Armour','Jack Wolfskin',
    'Birkenstock','UGG','Dr. Martens','Levis','Diesel','Polo','Ellesse','Lonsdale',
    'Ben Sherman','Napapijri','Marshall Artist','Sergio Tacchini','MA.Strum','Bench'
]

def extract_brand(name):
    for b in BRANDS:
        if b.lower() in name.lower():
            return b
    return name.split()[0] if name else ''

# ── Кэш картинок из предыдущего stock.json ──
# Кэшируем все пути (images[]) по имени товара
img_cache = {}  # name → [img/xxx.jpg, img/yyy.jpg, ...]
if os.path.exists('stock.json'):
    try:
        with open('stock.json', encoding='utf-8') as f:
            existing = json.load(f)
        for item in existing:
            paths = item.get('images') or ([item['img']] if item.get('img') else [])
            valid = [p for p in paths if p.startswith('img/') and os.path.exists(p)]
            if valid:
                img_cache[item['name']] = valid
        print(f'Кэш картинок: {len(img_cache)} товаров')
    except Exception as e:
        print(f'Кэш не загружен: {e}')

def get_img_urls(product_id, name):
    """Всегда спрашивает MoySklad список id, скачивает только недостающие файлы."""
    cached = img_cache.get(name, [])
    try:
        r = ms_get(f'{BASE}/entity/product/{product_id}/images?limit=100', timeout=30)
        rows = r.json().get('rows', [])
    except Exception as e:
        print(f'  Фото: API не ответил ({e}) — оставляю кэш ({len(cached)})')
        return cached

    if not rows:
        return []

    # id фото зашит в meta.href последним сегментом — вытаскиваем
    def extract_id(row):
        href = row.get('meta', {}).get('href', '')
        return href.rsplit('/', 1)[-1] if href else ''

    # Быстрый путь: если список в кэше совпадает с MoySklad и файлы на месте
    expected = [f"img/{extract_id(row)}.jpg" for row in rows if extract_id(row)]
    if expected == cached and all(os.path.exists(p) for p in cached):
        return cached

    # Медленный путь: качаем недостающие
    paths = []
    for row in rows:
        img_id = extract_id(row)
        download_href = row.get('meta', {}).get('downloadHref', '')
        if not (download_href and img_id):
            continue
        local_path = f'img/{img_id}.jpg'
        if not os.path.exists(local_path):
            try:
                img_data = requests.get(download_href, headers=HEADERS, timeout=30)
                if img_data.status_code == 200 and len(img_data.content) > 0:
                    with open(local_path, 'wb') as f:
                        f.write(img_data.content)
                else:
                    print(f'  ⚠️  фото {img_id}: HTTP {img_data.status_code}')
                    continue
            except Exception as e:
                print(f'  ⚠️  не скачал {img_id}: {e}')
                continue
        paths.append(local_path)
    return paths

# ── Шаг 1: Варианты (variant_id → product_id + размер) ──
print('Загружаем варианты...')
variant_info = {}  # variant_id → {'product_id':..., 'size':...}
offset, limit = 0, 100
while True:
    r = ms_get(f'{BASE}/entity/variant?limit={limit}&offset={offset}')
    data = r.json()
    rows = data.get('rows', [])
    total = data.get('meta', {}).get('size', 0)
    for row in rows:
        v_id = row.get('id', '')
        prod_href = row.get('product', {}).get('meta', {}).get('href', '')
        prod_id = prod_href.split('/')[-1] if prod_href else ''
        chars = row.get('characteristics', [])
        size = next((c['value'] for c in chars if 'размер' in c.get('name','').lower()), '')
        if v_id and prod_id:
            variant_info[v_id] = {'product_id': prod_id, 'size': size}
    print(f'  Варианты: {offset+len(rows)}/{total}')
    offset += limit
    if offset >= total:
        break

print(f'Всего вариантов: {len(variant_info)}')

# ── Шаг 2: Отчёт остатков (ТОЛЬКО положительные) ──
print('Загружаем отчёт остатков (positiveOnly)...')
in_stock_product_ids = set()
in_stock_sizes = defaultdict(list)  # product_id → [размеры в наличии]
offset = 0
while True:
    r = ms_get(f'{BASE}/report/stock/all?filter=stockMode%3DpositiveOnly&limit=1000&offset={offset}')
    data = r.json()
    rows = data.get('rows', [])
    total = data.get('meta', {}).get('size', 0)
    for row in rows:
        meta = row.get('meta', {})
        href = meta.get('href', '')
        item_type = meta.get('type', '')
        stock_qty = row.get('stock', 0)
        if stock_qty <= 0:
            continue
        item_id = href.split('/')[-1].split('?')[0]
        if item_type == 'product':
            in_stock_product_ids.add(item_id)
        elif item_type == 'variant':
            info = variant_info.get(item_id)
            if info:
                prod_id = info['product_id']
                size = info['size']
                in_stock_product_ids.add(prod_id)
                if size and size not in in_stock_sizes[prod_id]:
                    in_stock_sizes[prod_id].append(size)
    print(f'  Остатки: {offset+len(rows)}/{total}')
    offset += 1000
    if offset >= total:
        break

print(f'Товаров в наличии: {len(in_stock_product_ids)}')

# ── Шаг 3: Детали товаров (только тех, что в наличии) ──
print('Загружаем детали товаров...')
items = []
offset = 0
while True:
    r = ms_get(f'{BASE}/entity/product?limit=100&offset={offset}&filter=archived%3Dfalse')
    data = r.json()
    rows = data.get('rows', [])
    total = data.get('meta', {}).get('size', 0)

    for row in rows:
        prod_id = row['id']
        if prod_id not in in_stock_product_ids:
            continue
        if not row.get('salePrices'):
            continue
        price = row['salePrices'][0].get('value', 0)
        if price == 0:
            continue

        name = row['name']
        path_parts = (row.get('pathName') or '').split('/')
        category = path_parts[-1].strip() if path_parts else ''
        sizes = in_stock_sizes.get(prod_id, [])

        was_cached = name in img_cache
        images = get_img_urls(prod_id, name)

        items.append({
            'name': name,
            'brand': extract_brand(name),
            'price': round(price / 100),
            'sizes': sizes,
            'category': category,
            'img': images[0] if images else '',   # первое фото для превью (обратная совместимость)
            'images': images,                      # все фото для галереи
            'description': row.get('description', '')
        })
        cached = '(кэш)' if was_cached else '(новое)'
        print(f'[{len(items)}] {name[:40]} | размеры:{len(sizes)} | фото:{len(images)} {cached}')

    offset += 100
    if offset >= total:
        break

with open('stock.json', 'w', encoding='utf-8') as f:
    json.dump(items, f, ensure_ascii=False, indent=2)

print(f'\n✅ stock.json обновлён: {len(items)} товаров в наличии')
