import requests, json

MS_TOKEN = '3b701e01c5660188053b898da86779c282b1c527'
HEADERS = {'Authorization': f'Bearer {MS_TOKEN}', 'Accept': 'application/json;charset=utf-8'}
BASE = 'https://api.moysklad.ru/api/remap/1.2'

BRANDS = ['Nike','Adidas','New Balance','Puma','Converse','Vans','The North Face',
    'Tommy Hilfiger','Calvin Klein','Ralph Lauren','Hugo Boss','Lacoste','Fred Perry',
    'Gant','Weekend Offender','Columbia','Helly Hansen','Under Armour','Jack Wolfskin',
    'Birkenstock','UGG','Dr. Martens','Levis','Diesel','Polo']

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
            mini = rows[0].get('miniature', {})
            return mini.get('href', '')
    except:
        pass
    return ''

# Получаем все товары постранично
items = []
offset = 0
limit = 100

while True:
    r = requests.get(f'{BASE}/entity/product?limit={limit}&offset={offset}&filter=archived%3Dfalse', headers=HEADERS)
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
        img = get_image(product_id)

        path_parts = (row.get('pathName') or '').split('/')
        category = path_parts[-1] if path_parts else ''

        items.append({
            'name': row['name'],
            'brand': extract_brand(row['name']),
            'price': round(price / 100),
            'quantity': 1,
            'size': '',
            'category': category,
            'img': img
        })
        print(f'[{len(items)}/{total}] {row["name"]} — {round(price/100)} ₽')

    offset += limit
    if offset >= total:
        break

with open('stock.json', 'w', encoding='utf-8') as f:
    json.dump(items, f, ensure_ascii=False, indent=2)

print(f'\n✅ stock.json записан: {len(items)} товаров')
