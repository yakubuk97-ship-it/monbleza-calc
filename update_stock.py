"""
Hourly stock updater for GitHub Actions.
Downloads images to img/ folder — served directly via GitHub Pages.
Caches existing images to avoid re-downloading every run.
"""
import requests, json, os

MS_TOKEN = '3b701e01c5660188053b898da86779c282b1c527'
HEADERS = {'Authorization': f'Bearer {MS_TOKEN}', 'Accept': 'application/json;charset=utf-8'}
BASE = 'https://api.moysklad.ru/api/remap/1.2'
os.makedirs('img', exist_ok=True)

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

# ── Загружаем кэш картинок из существующего stock.json ──
img_cache = {}  # name → img_path (img/xxxxx.jpg)
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
    """Get image: from cache first, then download from MoySklad API."""
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

# ── Шаг 1: Загружаем варианты (размеры) ──
print('Загружаем варианты...')
variant_map = {}
offset, limit = 0, 100
while True:
    r = requests.get(f'{BASE}/entity/variant?limit={limit}&offset={offset}', headers=HEADERS, timeout=30)
    data = r.json()
    rows = data.get('rows', [])
    total = data.get('meta', {}).get('size', 0)
    for row in rows:
        prod_href = row.get('product', {}).get('meta', {}).get('href', '')
        prod_id = prod_href.split('/')[-1] if prod_href else ''
        chars = row.get('characteristics', [])
        size = next((c['value'] for c in chars if 'размер' in c.get('name','').lower()), '')
        if prod_id and size:
            variant_map.setdefault(prod_id, [])
            if size not in variant_map[prod_id]:
                variant_map[prod_id].append(size)
    print(f'  Варианты: {offset+len(rows)}/{total}')
    offset += limit
    if offset >= total:
        break

print(f'Товаров с размерами: {len(variant_map)}')

# ── Шаг 2: Загружаем товары ──
print('Загружаем товары...')
items = []
offset = 0
while True:
    r = requests.get(
        f'{BASE}/entity/product?limit=100&offset={offset}&filter=archived%3Dfalse',
        headers=HEADERS, timeout=30
    )
    data = r.json()
    rows = data.get('rows', [])
    total = data.get('meta', {}).get('size', 0)

    for row in rows:
        if not row.get('salePrices'):
            continue
        price = row['salePrices'][0].get('value', 0)
        if price == 0:
            continue

        product_id = row['id']
        name = row['name']
        path_parts = (row.get('pathName') or '').split('/')
        category = path_parts[-1].strip() if path_parts else ''
        sizes = variant_map.get(product_id, [])

        img = get_img_url(product_id, name)

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
        print(f'[{len(items)}/{total}] {name[:40]} | {cached}')

    offset += 100
    if offset >= total:
        break

with open('stock.json', 'w', encoding='utf-8') as f:
    json.dump(items, f, ensure_ascii=False, indent=2)

print(f'\n✅ stock.json обновлён: {len(items)} товаров')
