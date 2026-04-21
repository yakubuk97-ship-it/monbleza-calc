import json, re, sys, hashlib, os

with open('zalando_data.json', encoding='utf-8') as f:
    data = json.load(f)

print(f'Данных с Zalando: {len(data)} товаров')

# Load StreetStyle24 data if available
ss_data = []
if os.path.exists('streetstyle_data.json'):
    with open('streetstyle_data.json', encoding='utf-8') as f:
        ss_data = json.load(f)
    print(f'Данных с StreetStyle24: {len(ss_data)} товаров')

# Load Answear data if available
answear_data = []
if os.path.exists('answear_data.json'):
    with open('answear_data.json', encoding='utf-8') as f:
        answear_data = json.load(f)
    print(f'Данных с Answear: {len(answear_data)} товаров')

# Load Joe's New Balance Outlet data if available
joes_data = []
if os.path.exists('joes_data.json'):
    with open('joes_data.json', encoding='utf-8') as f:
        joes_data = json.load(f)
    print(f'Данных с Joe\'s NB Outlet: {len(joes_data)} товаров')

if len(data) == 0 and len(ss_data) == 0 and len(answear_data) == 0 and len(joes_data) == 0:
    print('❌ Пустой результат — файлы не меняем')
    sys.exit(0)

# PLN → EUR conversion rate
PLN_TO_EUR = 4.25
# USD → EUR conversion rate (Joe's prices в $)
USD_TO_EUR = 0.92

def get_cat(name, color=''):
    n = name.upper()
    for m in ['9060','1906','550','480','204','574','530','327','2002','993','990','998','860','1080','1500','240']:
        if m in n: return m
    # Sneaker keywords (for items that don't have a model number)
    if any(w in n for w in ['SNEAKER','AIR MAX','DUNK','FORCE 1','AIR FORCE','FORUM','STAN SMITH','SUPERSTAR','CLASSIC','CHUCK','OLD SKOOL','ERA ','AUTHENTIC','SK8']):
        return 'sneaker'
    # Hoodie/sweatshirt (German: Hoodie, Sweatshirt, Kapuzenpullover)
    if any(w in n for w in ['HOODIE','SWEATSHIRT','PULLOVER','HOODY','KAPUZENPULLOVER','FLEECE']):
        return 'hoodie'
    # T-shirt (German: T-Shirt, Shirt)
    if any(w in n for w in ['T-SHIRT','TEE','TSHIRT',' SHIRT','LONGSLEEVE','LANGARMSHIRT']):
        return 'tshirt'
    # Jacket (German: Jacke, Windbreaker, Anorak, Parka)
    if any(w in n for w in ['JACKET','PARKA','WINDBREAKER','ANORAK','JACKE','BLOUSON','STEPPJACKE']):
        return 'jacket'
    # Joggers/pants (German: Jogginghose, Trainingshose)
    if any(w in n for w in ['JOGGER','SWEATPANT','TRACKPANT','TROUSER','JOGGINGHOSE','TRAININGSHOSE','HOSE']):
        return 'jogger'
    return 'other'

products = []
seen_imgs = set()

for p in data:
    raw = (p.get('name','')
           .replace(' UNISEX','')
           .replace(' - Trainers','')
           .replace(' - Low-top trainers','')
           .replace(' - Sneaker low','')
           .replace(' - Sneaker high','')
           .replace(' - Hoodie','')
           .replace(' - Sweatshirt','')
           .replace(' - Jogginghose','')
           .replace(' - Trainingsjacke','')
           .replace(' - T-Shirt print','')
           .replace(' - T-Shirt basic','')
           .replace(' - T-Shirt','')
           .replace(' - Shirt','')
           .replace(' - Jacke','')
           .replace(' - Kapuzenpullover','')
           .strip())
    parts = raw.split(' - ')
    model = parts[0].strip()
    color = parts[1].strip() if len(parts)>1 else ''
    try: price = int(str(p.get('originalPrice',0))) / 100
    except: continue
    if price <= 0: continue
    try: promo = int(str(p.get('promotionalPrice',0))) / 100 if p.get('promotionalPrice') else None
    except: promo = None
    # Уменьшаем картинки: 762→400px — вдвое меньше трафика
    img = p.get('imageUrl','').replace('imwidth=762','imwidth=400').replace('imwidth=300','imwidth=400')
    url = p.get('productUrl','')
    if img in seen_imgs: continue
    seen_imgs.add(img)
    is_sale = bool(promo and promo < price)
    brand = p.get('brand','') or 'Unknown'
    sizes = p.get('sizes', [])
    products.append({'name':model,'color':color,'brand':brand,'price':price,'oldPrice':promo if is_sale else None,'sale':is_sale,'cat':get_cat(model, color),'img':img,'url':url,'sizes':sizes,'src':'zal'})

print(f'Zalando уникальных: {len(products)}')

# === StreetStyle24 processing ===
for p in ss_data:
    name_raw = p.get('name','').strip()
    if not name_raw: continue

    # Price in PLN → convert to EUR
    sell_pln = p.get('sellPrice', 0)
    base_pln = p.get('basePrice', None)
    if not sell_pln or sell_pln <= 0: continue

    price_eur = round(sell_pln / PLN_TO_EUR, 2)
    old_eur = round(base_pln / PLN_TO_EUR, 2) if base_pln and base_pln > sell_pln else None

    img = p.get('imageUrl', '')
    if not img: continue
    if img in seen_imgs: continue
    seen_imgs.add(img)

    url = p.get('productUrl', '')
    brand = p.get('brand', '') or 'Unknown'
    sizes = p.get('sizes', [])
    is_sale = bool(old_eur and old_eur > price_eur)

    # Name: Polish names often "Buty męskie Brand Model - color"
    # Try to split off the color after last " - "
    parts = name_raw.split(' - ')
    model = parts[0].strip()
    color = parts[-1].strip() if len(parts) > 1 else ''
    if color == model: color = ''

    products.append({'name':model,'color':color,'brand':brand,'price':price_eur,'oldPrice':old_eur,'sale':is_sale,'cat':get_cat(model, color),'img':img,'url':url,'sizes':sizes,'src':'ss24'})

ss_count = sum(1 for p in products if p.get('src') == 'ss24')
print(f'StreetStyle24 добавлено: {ss_count}')

# === Answear processing ===
for p in answear_data:
    name_raw = p.get('name', '').strip()
    subtitle = p.get('subtitle', '').strip()
    if not name_raw: continue

    sell_pln = p.get('price', 0)
    base_pln = p.get('priceRegular', None)
    if not sell_pln or sell_pln <= 0: continue

    price_eur = round(sell_pln / PLN_TO_EUR, 2)
    old_eur = round(base_pln / PLN_TO_EUR, 2) if base_pln and base_pln > sell_pln else None

    img = p.get('img', '')
    if not img: continue
    if img in seen_imgs: continue
    seen_imgs.add(img)

    url = p.get('url', '')
    brand = p.get('brand', '') or 'Unknown'
    # Use available sizes; fall back to all sizes
    sizes = p.get('sizes') or p.get('sizesAll', [])
    is_sale = bool(old_eur and old_eur > price_eur)

    # Name: combine name + subtitle for better display
    full_name = name_raw
    if subtitle and subtitle.lower() not in name_raw.lower():
        full_name = f'{name_raw} {subtitle}'

    parts = full_name.split(' - ')
    model = parts[0].strip()
    color = parts[-1].strip() if len(parts) > 1 else ''
    if color == model: color = ''

    products.append({'name': model, 'color': color, 'brand': brand, 'price': price_eur,
                     'oldPrice': old_eur, 'sale': is_sale, 'cat': get_cat(model, color),
                     'img': img, 'url': url, 'sizes': sizes, 'src': 'answear'})

aw_count = sum(1 for p in products if p.get('src') == 'answear')
print(f'Answear добавлено: {aw_count}')

# === Joe's New Balance Outlet processing (USD) ===
for p in joes_data:
    name = (p.get('name') or '').strip()
    if not name: continue

    orig_usd = p.get('originalPrice')
    promo_usd = p.get('promotionalPrice')
    try: orig_usd = float(orig_usd) if orig_usd is not None else None
    except: orig_usd = None
    try: promo_usd = float(promo_usd) if promo_usd is not None else None
    except: promo_usd = None

    # Цена — акционная если есть, иначе оригинальная
    price_usd = promo_usd if (promo_usd and promo_usd > 0) else orig_usd
    if not price_usd or price_usd <= 0: continue

    price_eur = round(price_usd * USD_TO_EUR, 2)
    old_eur = round(orig_usd * USD_TO_EUR, 2) if (orig_usd and promo_usd and orig_usd > promo_usd) else None

    img = p.get('imageUrl', '')
    if not img: continue
    if img in seen_imgs: continue
    seen_imgs.add(img)

    # Увеличиваем фото до 800×800 (по умолчанию 440×440 — слишком мелко)
    def hi_res(u):
        if not u: return u
        return u.replace('wid=440&hei=440', 'wid=800&hei=800')

    img_hi = hi_res(img)
    imgs_hi = [hi_res(u) for u in (p.get('images') or [img]) if u]
    # Уберём дубликаты, сохранив порядок
    seen_local = set()
    imgs_hi = [u for u in imgs_hi if not (u in seen_local or seen_local.add(u))]

    url = p.get('productUrl', '')
    brand = p.get('brand') or 'New Balance'
    color = p.get('color') or ''
    sizes = p.get('sizes', [])
    is_sale = bool(old_eur and old_eur > price_eur)

    products.append({'name': name, 'color': color, 'brand': brand, 'price': price_eur,
                     'oldPrice': old_eur, 'sale': is_sale, 'cat': get_cat(name, color),
                     'img': img_hi, 'imgs': imgs_hi, 'url': url, 'sizes': sizes, 'src': 'joes'})

joes_count = sum(1 for p in products if p.get('src') == 'joes')
print(f'Joe\'s NB добавлено: {joes_count}')
print(f'Обработано уникальных товаров: {len(products)}')

if len(products) == 0:
    print('❌ После фильтрации 0 товаров — файлы не меняем')
    sys.exit(0)

def js_p(p):
    old = f',op:{p["oldPrice"]}' if p['oldPrice'] else ''
    sale = ',sale:1' if p['sale'] else ''
    n = p['name'].replace('\\','\\\\').replace('"','\\"')
    c = p['color'].replace('\\','\\\\').replace('"','\\"')
    b = p['brand'].replace('\\','\\\\').replace('"','\\"')
    sizes_js = json.dumps(p.get('sizes',[]), separators=(',',':'))
    return f'["{n}","{c}","{b}",{p["price"]}{old}{sale},"{p["cat"]}","{p["img"]}","{p["url"]}",{sizes_js}]'

# Компактный формат: массив массивов вместо объектов — ~40% меньше размер файла
products_js = 'var products=[\n' + ',\n'.join(js_p(p) for p in products) + '\n].map(r=>({name:r[0],color:r[1],brand:r[2],price:r[3],...(r.includes&&typeof r[4]==="number"?{op:r[4]}:{}),cat:r.find?.(v=>typeof v==="string"&&["9060","530","574","574","hoodie","tshirt","jacket","jogger","other"].includes(v))||"other",img:r[r.length-2],url:r[r.length-1],sizes:r[r.length>8?r.length-0:8]}));'

# Пересчитываем — используем простой формат объектов (надёжнее)
def js_obj(p):
    old = f',oldPrice:{p["oldPrice"]}' if p['oldPrice'] else ''
    sale = ',sale:true' if p['sale'] else ''
    src = f',src:"{p["src"]}"' if p.get('src') else ''
    # imgs (массив) сохраняем только если фото больше одного — экономия размера
    imgs = p.get('imgs') or []
    imgs_js = ''
    if len(imgs) > 1:
        imgs_js = ',g:' + json.dumps(imgs, separators=(',',':'))
    n = p['name'].replace('\\','\\\\').replace('"','\\"')
    c = p['color'].replace('\\','\\\\').replace('"','\\"')
    b = p['brand'].replace('\\','\\\\').replace('"','\\"')
    sizes_js = json.dumps(p.get('sizes',[]), separators=(',',':'))
    return f'{{n:"{n}",c:"{c}",b:"{b}",p:{p["price"]}{old}{sale},cat:"{p["cat"]}",i:"{p["img"]}",u:"{p["url"]}",s:{sizes_js}{src}{imgs_js}}}'

products_js = 'var products=[\n' + ',\n'.join(js_obj(p) for p in products) + '\n].map(r=>({name:r.n,color:r.c,brand:r.b,price:r.p,oldPrice:r.oldPrice||null,sale:!!r.sale,cat:r.cat,img:r.i,imgs:r.g||[r.i],url:r.u,sizes:r.s||[],src:r.src||"zal"}));'

# Хэш для cache-busting
content_hash = hashlib.md5(products_js.encode()).hexdigest()[:8]

# Записываем products.js
with open('products.js', 'w', encoding='utf-8') as f:
    f.write(products_js)
print(f'✅ products.js записан ({len(products_js)//1024}KB), hash={content_hash}')

# Обновляем index.html
with open('index.html', encoding='utf-8') as f:
    html = f.read()

# Обновляем src у тега products.js с cache-busting хэшем
html = re.sub(r'<script src="products\.js[^"]*">', f'<script src="products.js?v={content_hash}">', html)
# Обновляем счётчик товаров
html = re.sub(r'\d+ моделей', f'{len(products)} моделей', html)

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(html)

print(f'✅ index.html обновлён: {len(products)} товаров, hash={content_hash}')
