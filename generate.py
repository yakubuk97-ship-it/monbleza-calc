import json, re, sys, hashlib

with open('zalando_data.json', encoding='utf-8') as f:
    data = json.load(f)

print(f'Данных с Apify: {len(data)} товаров')

if len(data) == 0:
    print('❌ Пустой результат — файлы не меняем')
    sys.exit(0)

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
    products.append({'name':model,'color':color,'brand':brand,'price':price,'oldPrice':promo if is_sale else None,'sale':is_sale,'cat':get_cat(model, color),'img':img,'url':url,'sizes':sizes})

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
    n = p['name'].replace('\\','\\\\').replace('"','\\"')
    c = p['color'].replace('\\','\\\\').replace('"','\\"')
    b = p['brand'].replace('\\','\\\\').replace('"','\\"')
    sizes_js = json.dumps(p.get('sizes',[]), separators=(',',':'))
    return f'{{n:"{n}",c:"{c}",b:"{b}",p:{p["price"]}{old}{sale},cat:"{p["cat"]}",i:"{p["img"]}",u:"{p["url"]}",s:{sizes_js}}}'

products_js = 'var products=[\n' + ',\n'.join(js_obj(p) for p in products) + '\n].map(r=>({name:r.n,color:r.c,brand:r.b,price:r.p,oldPrice:r.oldPrice||null,sale:!!r.sale,cat:r.cat,img:r.i,url:r.u,sizes:r.s||[]}));'

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
