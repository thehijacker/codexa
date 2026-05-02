# -*- coding: utf-8 -*-
#! /usr/bin/env python3

import os
import re
import json

# Nastavitve
JSON_FILE = 'locales/sl.json'
# Direktorija, ki ju želimo pregledati
DIRECTORIES = ['.', '../server']
EXTENSIONS = ('.html', '.js')

# POSODOBLJENI VZORCI
# 1. Standardni i18next vzorci (HTML in JS)
html_pattern = re.compile(r'data-i18n(?:-placeholder)?=["\']([a-zA-Z0-9._-]+)["\']')
js_t_pattern = re.compile(r'\bt\(\s*[\'"]([a-zA-Z0-9._-]+)[\'"]\s*[,)]')

# 2. Server-side vzorec: išče nize, ki se začnejo z 'error.' ali 'common.' znotraj narekovajev
# To bo ujelo: { error: 'error.credentials_required' }
server_pattern = re.compile(r'[\'"]((?:error|common|library|reader|settings)\.[a-zA-Z0-9._-]+)[\'"]')

def get_keys_from_files():
    found_keys = set()
    for base_path in DIRECTORIES:
        if not os.path.exists(base_path):
            print(f"Opozorilo: Pot {base_path} ne obstaja, preskakujem.")
            continue
            
        for root, dirs, files in os.walk(base_path):
            # Preskoči nepotrebne mape
            if any(skip in root for skip in ['node_modules', '.git', 'icons', 'dist']):
                continue
                
            for file in files:
                if file.endswith(EXTENSIONS):
                    path = os.path.join(root, file)
                    try:
                        with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                            content = f.read()
                            # Uporaba vseh treh vzorcev
                            found_keys.update(html_pattern.findall(content))
                            found_keys.update(js_t_pattern.findall(content))
                            found_keys.update(server_pattern.findall(content))
                    except Exception as e:
                        print(f"Napaka pri branju {path}: {e}")
    return found_keys

def check_translations():
    if not os.path.exists(JSON_FILE):
        print(f"NAPAKA: Datoteka {JSON_FILE} ni bila najdena!")
        return

    try:
        with open(JSON_FILE, 'r', encoding='utf-8') as f:
            translations = json.load(f)
    except Exception as e:
        print(f"Napaka pri branju JSON datoteke: {e}")
        return

    keys_in_code = get_keys_from_files()
    keys_in_json = set(translations.keys())

    missing = sorted(list(keys_in_code - keys_in_json))
    unused = sorted(list(keys_in_json - keys_in_code))

    print("=" * 50)
    print(f"Analiza prevodov (vključno s /server)")
    print("-" * 50)
    print(f"Ključev v kodi (skupaj): {len(keys_in_code)}")
    print(f"Ključev v {JSON_FILE}: {len(keys_in_json)}")
    print("=" * 50)

    if missing:
        print(f"\n[!] MANJKI V JSON ({len(missing)}):")
        for key in missing:
            print(f"  \"{key}\": \"\",")
    else:
        print("\n[V] Vsi ključi iz kode so v JSON datoteki.")

    if unused:
        print(f"\n[?] MOŽNO NEUPORABLJENO ({len(unused)}):")
        for key in unused:
            print(f"  - {key}")

if __name__ == "__main__":
    check_translations()