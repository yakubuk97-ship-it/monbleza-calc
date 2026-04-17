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
img_cache = {}
if os.path.exists('stock.json'):
    try:
        with open('stock.json', encoding='utf-8') as f:
            existing = json.load(f)
        for item in existing:
            img = item.get('img', '')
            if img and img.startswith('img/') and os.path.exists(img):
                img_cache[item['name']] = img
        print(f'Кэш картинок: {len(img_cache)} товаров')
    except Exception as e:
        print(f'Кэш не загружен: {e}')

def get_img_url(product_id, name):
    if name in img_cache:
        return img_cache[name]
    try:
        r = requests.get(
            f'{BASE}/entity/product/{product_id}/images?limit=1',
            headers=HEADERS, timeout=10
        )
        rows = r.json().get('rows', [])
        if rows:
            img_id = rows[0].get('id', '')
            download_href = rows[0].get('meta', {}).get('downloadHref', '')
            if download_href and img_id:
                local_path = f'img/{img_id}.jpg'
                if not os.path.exists(local_path):
                    img_data = requests.get(download_href, headers=HEADERS, timeout=15)
                    if img_data.status_code == 200:
                        with open(local_path, 'wb') as f:
                            f.write(img_data.content)
                img_cache[name] = local_path
                return local_path
    except Exception as e:
        print(f'  Фото не получено: {e}')
    return ''

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

        img = get_img_url(prod_id, name)

        items.append({
            'name': name,
            'brand': extract_brand(name),
            'price': round(price / 100),
            'sizes': sizes,
            'category': category,
            'img': img,
            'description': row.get('description', '')
        })
        cached = '(кэш)' if name in img_cache else '(новое)'
        print(f'[{len(items)}] {name[:40]} | размеры:{len(sizes)} {cached}')

    offset += 100
    if offset >= total:
        break

with open('stock.json', 'w', encoding='utf-8') as f:
    json.dump(items, f, ensure_ascii=False, indent=2)

print(f'\n✅ stock.json обновлён: {len(items)} товаров в наличии')
