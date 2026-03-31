import json, re

with open('zalando_data.json', encoding='utf-8') as f:
    data = json.load(f)

def get_cat(name):
    for m in ['9060','1906','550','480','204','574','530','327']:
        if m in name.upper():
            return m
    return 'other'

products = []
seen_imgs = set()

for p in data:
    raw = p.get('name','').replace(' UNISEX','').replace(' - Trainers','').replace(' - Low-top trainers','').strip()
    parts = raw.split(' - ')
    model = parts[0].strip()
    color = parts[1].strip() if len(parts)>1 else ''
    try: price = int(str(p.get('originalPrice',0))) / 100
    except: continue
    if price <= 0: continue
    try: promo = int(str(p.get('promotionalPrice',0))) / 100 if p.get('promotionalPrice') else None
    except: promo = None
    img = p.get('imageUrl','').replace('imwidth=300','imwidth=762')
    url = p.get('productUrl','')
    if img in seen_imgs: continue
    seen_imgs.add(img)
    is_sale = bool(promo and promo < price)
    products.append({'name':model,'color':color,'price':price,'oldPrice':promo if is_sale else None,'sale':is_sale,'cat':get_cat(model),'img':img,'url':url})

def js_product(p):
    old = f', oldPrice:{p["oldPrice"]}' if p['oldPrice'] else ''
    sale = ', sale:true' if p['sale'] else ''
    return f'  {{name:"{p["name"].replace(chr(34),chr(92)+chr(34))}",color:"{p["color"].replace(chr(34),chr(92)+chr(34))}",price:{p["price"]}{old}{sale},cat:"{p["cat"]}",img:"{p["img"]}",url:"{p["url"]}"}}'

products_js = 'const products=[\n' + ',\n'.join(js_product(p) for p in products) + '\n];'

with open('index.html', encoding='utf-8') as f:
    html = f.read()

html = re.sub(r'const products=\[.*?\];', products_js, html, flags=re.DOTALL)
html = re.sub(r'\d+ моделей', f'{len(products)} моделей', html)

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(html)

print(f'✅ Обновлено: {len(products)} товаров')
