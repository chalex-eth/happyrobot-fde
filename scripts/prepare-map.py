import urllib.request,json,zipfile,io,pathlib,concurrent.futures
urls=['https://download.geonames.org/export/dump/cities15000.zip','https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson']
with concurrent.futures.ThreadPoolExecutor() as e:
 data=list(e.map(lambda u:urllib.request.urlopen(u,timeout=40).read(),urls))
z=zipfile.ZipFile(io.BytesIO(data[0])); cities={}
for line in z.read('cities15000.txt').decode().splitlines():
 f=line.split('\t')
 if f[8]!='US': continue
 for name in set([f[1],f[2]]):
  key=name.lower()+'|'+f[10]
  if key not in cities or int(f[14])>cities[key][2]:cities[key]=[round(float(f[5]),4),round(float(f[4]),4),int(f[14])]
pathlib.Path('src/data/us-cities.json').write_text(json.dumps({k:v[:2] for k,v in sorted(cities.items())},separators=(',',':'))+'\n')
geo=json.loads(data[1]); usa=next(f for f in geo['features'] if f['properties']['ADM0_A3']=='USA')
def project(p):
 x,y=p
 if -126<=x<=-66 and 24<=y<=50:return [(x+126)/60*900+40,(50-y)/26*420+30]
 if -180<=x<=-129 and 50<=y<=73:return [(x+180)/51*165+45,(73-y)/23*100+465]
 if -161<=x<=-154 and 18<=y<=23:return [(x+161)/7*90+245,(23-y)/5*65+490]
paths=[]
for polygon in usa['geometry']['coordinates']:
 for ring in polygon:
  pts=[project(p) for p in ring]
  if any(p is None for p in pts):continue
  paths.append('M'+'L'.join(f'{x:.1f},{y:.1f}' for x,y in pts)+'Z')
pathlib.Path('src/data/us-outline.json').write_text(json.dumps(paths)+'\n')
print('Prepared',len(cities),'city coordinates and',len(paths),'map polygons')
