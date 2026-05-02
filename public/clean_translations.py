# -*- coding: utf-8 -*-
#! /usr/bin/env python3

import os
import json

# Pot do mape s prevodi
LOCALES_DIR = 'locales'

# Seznam ključev za izbris
KEYS_TO_REMOVE = [
    "common.language", "common.loading", "common.saving", "library.book_deleted",
    "library.books_deleted", "library.books_removed", "library.btn_cancel_edit",
    "library.btn_create", "library.btn_del_shelf", "library.bulk_done",
    "library.clear_filter", "library.confirm_del_shelf", "library.confirm_remove",
    "library.edit_shelf_title", "library.epub_only", "library.new_shelf_title",
    "library.no_shelves_assign", "library.page_all", "library.page_reading",
    "library.page_title", "library.shelf_created", "library.shelf_deleted",
    "library.shelf_fallback", "library.shelf_placeholder", "library.shelf_renamed",
    "library.shelves_updated", "library.tooltip_delete", "library.tooltip_info",
    "library.upload_done", "library.upload_loading", "opds.page_title",
    "reader.btn_back", "reader.btn_download", "reader.btn_jump_pct",
    "reader.btn_search", "reader.btn_search_accept", "reader.btn_search_back",
    "reader.btn_settings", "reader.btn_toc", "reader.dict_no_dicts2",
    "reader.dict_searching", "reader.edge_bottom", "reader.edge_left",
    "reader.edge_right", "reader.edge_top", "reader.loading_meta",
    "reader.next_page", "reader.pos_bottom", "reader.pos_top", "reader.prev_page",
    "reader.setting_autohide", "reader.setting_autohide_hint", "reader.setting_book_prog",
    "reader.setting_chap_prog", "reader.setting_dicts", "reader.setting_dicts_hint",
    "reader.setting_dicts_loading", "reader.setting_edge_pad", "reader.setting_edge_pad_hint",
    "reader.setting_eink", "reader.setting_eink_hint", "reader.setting_font",
    "reader.setting_fontsize", "reader.setting_keepawake", "reader.setting_keepawake_hint",
    "reader.setting_layout", "reader.setting_lineheight", "reader.setting_margin",
    "reader.setting_mousewheel", "reader.setting_mousewheel_hint", "reader.setting_override",
    "reader.setting_override_hint", "reader.setting_para_indent", "reader.setting_para_indent_hint",
    "reader.setting_para_indent_size", "reader.setting_para_spacing", "reader.setting_prog_pos",
    "reader.setting_prog_thick", "reader.setting_sb", "reader.setting_sb_font",
    "reader.setting_sb_loading", "reader.setting_sb_sep", "reader.setting_sb_sep_bottom",
    "reader.setting_sb_sep_thick", "reader.setting_sb_sep_top", "reader.setting_sb_size",
    "reader.setting_skip_progress", "reader.setting_skip_progress_hint", "reader.setting_skip_save",
    "reader.setting_skip_save_hint", "reader.setting_theme", "settings.kosync_info_html",
    "sidebar.shelf_edit", "sidebar.theme_day_title", "sidebar.theme_eink_title",
    "sidebar.theme_night_title", "sidebar.theme_system_title"
]

def clean_json_files():
    if not os.path.exists(LOCALES_DIR):
        print(f"Napaka: Mapa '{LOCALES_DIR}' ne obstaja.")
        return

    # Preglej vse datoteke v mapi
    for filename in os.listdir(LOCALES_DIR):
        if filename.endswith('.json'):
            file_path = os.path.join(LOCALES_DIR, filename)
            
            try:
                # Branje datoteke
                with open(file_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                
                # Odstranjevanje ključev
                original_count = len(data)
                for key in KEYS_TO_REMOVE:
                    if key in data:
                        del data[key]
                
                new_count = len(data)
                removed_count = original_count - new_count
                
                # Shranjevanje posodobljene datoteke
                with open(file_path, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                
                print(f"Datoteka {filename}: Odstranjenih {removed_count} ključev. Ostalo: {new_count}.")

            except Exception as e:
                print(f"Napaka pri obdelavi {filename}: {e}")

if __name__ == "__main__":
    clean_json_files()
    print("\nČiščenje končano.")
