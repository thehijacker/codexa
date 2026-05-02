# -*- coding: utf-8 -*-
#! /usr/bin/env python3

import os
import re
import json

# Nastavitve
JSON_FILE = 'locales/sl.json'
EXTENSIONS = ('.html', '.js')

# POPRAVLJENI VZORCI
# 1. HTML: Išče data-i18n ali data-i18n-placeholder
html_pattern = re.compile(r'data-i18n(?:-placeholder)?=["\']([a-zA-Z0-9._-]+)["\']')

# 2. JS: Išče t('ključ' ali t("ključ", ne glede na to, kaj sledi (vejica, presledek, oklepaj)
js_pattern = re.compile(r'\bt\(\s*[\'"]([a-zA-Z0-9._-]+)[\'"]\s*[,)]')

def get_keys_from_files():
    found_keys = set()
    for root, dirs, files in os.walk('.'):
        if any(skip in root for skip in ['node_modules', '.git', 'icons', 'dist']):
            continue
            
        for file in files:
            if file.endswith(EXTENSIONS):
                path = os.path.join(root, file)
                try:
                    with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                        content = f.read()
                        # Dodajanje vseh najdenih ključev
                        found_keys.update(html_pattern.findall(content))
                        found_keys.update(js_pattern.findall(content))
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
    print(f"Analiza prevodov za: {JSON_FILE}")
    print("-" * 50)
    print(f"Ključev v kodi (zaznanih): {len(keys_in_code)}")
    print(f"Ključev v JSON datoteki: {len(keys_in_json)}")
    print("=" * 50)

    if missing:
        print(f"\n[!] MANJKI V {JSON_FILE} ({len(missing)}):")
        for key in missing:
            print(f"  \"{key}\": \"\",")
    else:
        print("\n[V] Vsi ključi iz kode so v JSON datoteki.")

    if unused:
        print(f"\n[?] MOŽNO NEUPORABLJENO ({len(unused)}):")
        # Izpišemo vse, da lahko preveriš
        for key in unused:
            print(f"  - {key}")

if __name__ == "__main__":
    check_translations()