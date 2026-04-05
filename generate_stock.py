import requests, json, os

MS_TOKEN = '3b701e01c5660188053b898da86779c282b1c527'
HEADERS = {'Authorization': f'Bearer {MS_TOKEN}', 'Accept': 'application/json;charset=utf-8'}
BASE = 'https://api.moysklad.ru/api/remap/1.2'

BRANDS = ['Nike','Adidas','New Balance','Puma','Converse','Vans','The North Face',
    'Tommy Hilfiger','Calvin Klein','Ralph Lauren','Hugo Boss','Lacoste','Fred Perry',
    'Gant','Weekend Offender','Columbia','Helly Hansen','Under Armour','Jack Wolfskin',
    'Birkenstock','UGG','Dr. Martens','Levis','Diesel','Polo','Ellesse','Lonsdale',
    'Ben Sherman','Napapijri','Marshall Artist','Sergio Tacchini','MA.Strum','Bench']

os.makedirs('img', exist_ok=True)

def extract_brand(name):
    for b in BRANDS:
        if b.lower() in name.lower():
            return b
    return name.split()[0] if name else ''

def get_image(product_id):
    try:
        r = requests.get(f'{BASE}/entity/product/{product_id}/images?limit=1', headers=HEADERS, timeout=10)
        rows = r.json().get('rows', [])
        if rows:
            return rows[0].get('meta', {}).get('downloadHref', '')
    except:
        pass
    return ''

def download_image(url, product_id):
    if not url:
        return ''
    local_path = f'img/{product_id}.jpg'
    if os.path.exists(local_path):
        return local_path
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        if r.status_code == 200 and len(r.content) > 1000:
            with open(local_path, 'wb') as f:
                f.write(r.content)
            return local_path
    except:
        pass
    return ''

# Шаг 1: Загружаем все варианты и группируем по product_id
print('Загружаем варианты...')
variant_map = {}
offset, limit = 0, 100
while True:
    r = requests.get(f'{BASE}/entity/variant?limit={limit}&offset={offset}', headers=HEADERS)
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

# Шаг 2: Загружаем все товары с ценами и фото
print('Загружаем товары...')
items = []
offset = 0
while True:
    r = requests.get(f'{BASE}/entity/product?limit=100&offset={offset}&filter=archived%3Dfalse', headers=HEADERS)
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
        img_url = get_image(product_id)
        local_img = download_image(img_url, product_id)
        path_parts = (row.get('pathName') or '').split('/')
        category = path_parts[-1] if path_parts else ''
        sizes = variant_map.get(product_id, [])

        items.append({
            'name': row['name'],
            'brand': extract_brand(row['name']),
            'price': round(price / 100),
            'sizes': sizes,
            'category': category,
            'img': local_img,
            'description': row.get('description', '')
        })
        print(f'[{len(items)}/{total}] {row["name"]} | img: {"✓" if local_img else "✗"}')

    offset += 100
    if offset >= total:
        break

with open('stock.json', 'w', encoding='utf-8') as f:
    json.dump(items, f, ensure_ascii=False, indent=2)

print(f'\n✅ stock.json записан: {len(items)} товаров')
print(f'📁 Фото сохранены в папку img/')
