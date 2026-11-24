"""家和万事兴 · 家谱与亲戚谱管理（多谱 / 多用户 / 权限 / 导入导出）

架构说明（便于后期接入微信小程序与部署）：
- 全部数据接口为 RESTful JSON，登录后通过 Authorization: Bearer <token> 鉴权；
- 一份「族谱」为一个数据隔离单元，成员、关系、审批均归属族谱；
- 亲戚谱（kinship）可跨族谱访问，其余接口按族谱隔离；
- 角色：admin（创建人，可转让）、branch_admin（分支管理员，增员需审批）、normal（只读）。
"""

import io
import json
import os
import secrets
import shutil
import sqlite3
from collections import deque
from datetime import datetime, timedelta
from functools import wraps
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import urlopen

from flask import Flask, g, jsonify, request, send_from_directory
from werkzeug.security import check_password_hash, generate_password_hash

try:
    from lunardate import LunarDate
except ImportError:  # 缺少依赖时仍可保存与展示生日，只是不做历法互转
    LunarDate = None

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "family.db")
UPLOAD_DIR = os.path.join(BASE_DIR, "static", "uploads")


def load_env_file(path):
    """读取项目根目录 .env（KEY=VALUE 每行一项），不覆盖已存在的系统环境变量。"""
    if not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8-sig") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            if key and key not in os.environ:
                os.environ[key] = value


load_env_file(os.path.join(BASE_DIR, ".env"))

# 云托管等部署环境可通过环境变量把数据目录、上传目录指向持久化存储（如挂载的 CFS）
_DATA_DIR_ENV = os.environ.get("DATA_DIR", "").strip()
if _DATA_DIR_ENV:
    DATA_DIR = _DATA_DIR_ENV
DB_PATH = os.environ.get("DB_PATH", "").strip() or os.path.join(DATA_DIR, "family.db")
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "").strip() or (
    os.path.join(DATA_DIR, "uploads") if _DATA_DIR_ENV else UPLOAD_DIR
)

MAX_GENERATIONS = 30
MAX_KINSHIP_LEVELS = 5
REL_TYPES = ("血缘", "配偶", "收养", "过继")
GENDERS = ("男", "女")
BIRTHDAY_TYPES = ("solar", "lunar")
ROLES = ("admin", "branch_admin", "normal")
ROLE_RANK = {"admin": 3, "branch_admin": 2, "normal": 1}
# 普通成员只能修改本人身份的个人资料，关系与结构字段不可改
PERSONAL_MEMBER_FIELDS = (
    "name", "gender", "birth_year", "death_year", "birthday", "birthday_type",
    "hometown", "zodiac", "contact", "residence", "photo",
)
TOKEN_TTL_DAYS = 7
WECHAT_APP_ID = os.environ.get("WECHAT_APP_ID", "").strip()
WECHAT_APP_SECRET = os.environ.get("WECHAT_APP_SECRET", "").strip()

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024
app.json.ensure_ascii = False


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


@app.errorhandler(ApiError)
def handle_api_error(err):
    return jsonify(ok=False, error=err.message), err.status


@app.errorhandler(413)
def handle_too_large(_):
    return jsonify(ok=False, error="文件体积过大，请上传 16MB 以内的文件"), 413


# --------------------------------------------------------------------------
# 数据库
# --------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS members (
    member_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    genealogy_id  INTEGER,
    code          TEXT    NOT NULL UNIQUE,
    name          TEXT    NOT NULL,
    gender        TEXT    NOT NULL DEFAULT '男',
    birth_year    INTEGER,
    death_year    INTEGER,
    birthday      TEXT,
    birthday_type TEXT,
    hometown      TEXT,
    sibling_rank  INTEGER,
    zodiac        TEXT,
    generation    INTEGER NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 30),
    contact       TEXT,
    residence     TEXT,
    photo         TEXT,
    father_id     INTEGER REFERENCES members(member_id),
    mother_id     INTEGER REFERENCES members(member_id),
    source_member_id INTEGER,
    created_at    TEXT DEFAULT (datetime('now','localtime')),
    updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS relations (
    relation_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id     INTEGER NOT NULL UNIQUE REFERENCES members(member_id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL DEFAULT '血缘'
                  CHECK (relation_type IN ('血缘', '配偶', '收养', '过继')),
    father_id     INTEGER,
    mother_id     INTEGER,
    spouse_array  TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS genealogies (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT,
    creator_id  INTEGER,
    visibility  TEXT NOT NULL DEFAULT 'private'
                CHECK (visibility IN ('public','private')),
    kind        TEXT NOT NULL DEFAULT 'family',
    is_default  INTEGER NOT NULL DEFAULT 0,
    owner_user_id       INTEGER,
    source_genealogy_id INTEGER,
    source_member_id    INTEGER,
    synced_at           TEXT,
    created_at  TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name  TEXT,
    wechat_openid TEXT,
    created_at    TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS genealogy_users (
    genealogy_id INTEGER NOT NULL,
    user_id      INTEGER NOT NULL,
    role         TEXT NOT NULL DEFAULT 'normal'
                 CHECK (role IN ('admin','branch_admin','normal')),
    member_id    INTEGER,
    PRIMARY KEY (genealogy_id, user_id)
);

CREATE TABLE IF NOT EXISTS tokens (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    expires_at  TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS proposals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    genealogy_id  INTEGER NOT NULL,
    proposer_id   INTEGER NOT NULL,
    action        TEXT NOT NULL,
    payload       TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    reviewed_by   INTEGER,
    reviewed_at   TEXT,
    reject_reason TEXT,
    created_at    TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_members_father ON members(father_id);
CREATE INDEX IF NOT EXISTS idx_members_mother ON members(mother_id);
CREATE INDEX IF NOT EXISTS idx_members_gen ON members(generation);
CREATE INDEX IF NOT EXISTS idx_members_genealogy ON members(genealogy_id);
CREATE INDEX IF NOT EXISTS idx_relations_member ON relations(member_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_openid ON users(wechat_openid) WHERE wechat_openid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_gu_member ON genealogy_users(genealogy_id, member_id) WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_source ON members(genealogy_id, source_member_id) WHERE source_member_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_kin_owner ON genealogies(source_genealogy_id, owner_user_id) WHERE kind='kinship';
"""

SEED_PEOPLE = [
    dict(key="wenyuan", name="陈文远", gender="男", generation=1, sibling_rank=1,
         birth_year=1860, death_year=1930, hometown="山东省蓬莱县", residence="蓬莱陈家庄",
         contact="", rel="血缘", spouses=["liu_shi"]),
    dict(key="liu_shi", name="刘氏", gender="女", generation=1,
         birth_year=1864, death_year=1935, hometown="山东省蓬莱县", residence="蓬莱陈家庄",
         contact="", rel="配偶", spouses=["wenyuan"]),
    dict(key="shouren", name="陈守仁", gender="男", generation=2, sibling_rank=1,
         birth_year=1888, death_year=1962, hometown="山东省蓬莱县", residence="蓬莱陈家庄",
         contact="", rel="血缘", father="wenyuan", mother="liu_shi", spouses=["wang_shi"]),
    dict(key="wang_shi", name="王氏", gender="女", generation=2,
         birth_year=1892, death_year=1968, hometown="山东省黄县", residence="蓬莱陈家庄",
         contact="", rel="配偶", spouses=["shouren"]),
    dict(key="shouxin", name="陈守信", gender="男", generation=2, sibling_rank=2,
         birth_year=1891, death_year=1955, hometown="山东省蓬莱县", residence="蓬莱城里",
         contact="", rel="血缘", father="wenyuan", mother="liu_shi"),
    dict(key="changshun", name="李长顺", gender="男", generation=2, sibling_rank=1,
         birth_year=1898, death_year=1958, hometown="山东省掖县", residence="掖县李家庄",
         contact="", rel="血缘", spouses=["zhang_guiying"]),
    dict(key="zhang_guiying", name="张桂英", gender="女", generation=2,
         birth_year=1900, death_year=1970, hometown="山东省掖县", residence="掖县李家庄",
         contact="", rel="配偶", spouses=["changshun"]),
    dict(key="guangde", name="陈广德", gender="男", generation=3, sibling_rank=1,
         birth_year=1912, death_year=1985, hometown="山东省蓬莱县", residence="蓬莱陈家庄",
         contact="0535-8800001", rel="血缘", father="shouren", mother="wang_shi", spouses=["li_shi"]),
    dict(key="li_shi", name="李氏", gender="女", generation=3,
         birth_year=1916, death_year=1993, hometown="山东省福山县", residence="蓬莱陈家庄",
         contact="", rel="配偶", spouses=["guangde"]),
    dict(key="guangfu", name="陈广福", gender="男", generation=3, sibling_rank=2,
         birth_year=1915, death_year=1990, hometown="山东省蓬莱县", residence="蓬莱潮水镇",
         contact="0535-8800002", rel="血缘", father="shouren", mother="wang_shi", spouses=["zhang_shi"]),
    dict(key="zhang_shi", name="张氏", gender="女", generation=3,
         birth_year=1919, death_year=1988, hometown="山东省栖霞县", residence="蓬莱潮水镇",
         contact="", rel="配偶", spouses=["guangfu"]),
    dict(key="guanglu", name="陈广禄", gender="男", generation=3, sibling_rank=3,
         birth_year=1918, death_year=2001, hometown="山东省蓬莱县", residence="蓬莱大辛店",
         contact="0535-8800003", rel="血缘", father="shouren", mother="wang_shi", spouses=["zhao_shi"]),
    dict(key="zhao_shi", name="赵氏", gender="女", generation=3,
         birth_year=1922, death_year=2005, hometown="山东省莱阳县", residence="蓬莱大辛店",
         contact="", rel="配偶", spouses=["guanglu"]),
    dict(key="xiuying", name="陈秀英", gender="女", generation=3, sibling_rank=4,
         birth_year=1921, death_year=1998, hometown="山东省蓬莱县", residence="烟台市芝罘区",
         contact="", rel="血缘", father="shouren", mother="wang_shi", spouses=["sun_dehai"]),
    dict(key="sun_dehai", name="孙德海", gender="男", generation=3,
         birth_year=1919, death_year=1996, hometown="山东省荣成县", residence="烟台市芝罘区",
         contact="", rel="配偶", spouses=["xiuying"]),
    dict(key="wang_dehai", name="王德海", gender="男", generation=3, sibling_rank=1,
         birth_year=1920, death_year=1999, hometown="山东省蓬莱县", residence="蓬莱王沟村",
         contact="", rel="血缘", spouses=["li_guifang"]),
    dict(key="li_guifang", name="李桂芳", gender="女", generation=3,
         birth_year=1923, death_year=1996, hometown="山东省掖县", residence="蓬莱王沟村",
         contact="", rel="血缘", father="changshun", mother="zhang_guiying", spouses=["wang_dehai"]),
    dict(key="jianguo", name="陈建国", gender="男", generation=4, sibling_rank=1,
         birth_year=1945, hometown="山东省蓬莱县", residence="济南市历下区",
         contact="138 0000 0001", rel="血缘", father="guangde", mother="li_shi", spouses=["wang_xiulan"]),
    dict(key="jianhua", name="陈建华", gender="男", generation=4, sibling_rank=2,
         birth_year=1948, hometown="山东省蓬莱县", residence="青岛市市南区",
         contact="138 0000 0002", rel="血缘", father="guangde", mother="li_shi", spouses=["zhou_min"]),
    dict(key="wang_xiulan", name="王秀兰", gender="女", generation=4, sibling_rank=1,
         birth_year=1950, hometown="山东省蓬莱县", residence="济南市历下区",
         contact="138 0000 0003", rel="配偶", father="wang_dehai", mother="li_guifang", spouses=["jianguo"]),
    dict(key="wang_xiufang", name="王秀芳", gender="女", generation=4, sibling_rank=2,
         birth_year=1953, hometown="山东省蓬莱县", residence="蓬莱王沟村",
         contact="138 0000 0004", rel="血缘", father="wang_dehai", mother="li_guifang"),
    dict(key="jianye", name="陈建业", gender="男", generation=4, sibling_rank=1,
         birth_year=1950, hometown="山东省蓬莱县", residence="烟台市莱山区",
         contact="138 0000 0005", rel="血缘", father="guangfu", mother="zhang_shi", spouses=["liu_fang"]),
    dict(key="jianmin", name="陈建民", gender="男", generation=4, sibling_rank=1,
         birth_year=1952, hometown="山东省蓬莱县", residence="威海市环翠区",
         contact="138 0000 0006", rel="血缘", father="guanglu", mother="zhao_shi", spouses=["sun_li"]),
    dict(key="zhou_min", name="周敏", gender="女", generation=4,
         birth_year=1952, hometown="山东省青岛市", residence="青岛市市南区",
         contact="", rel="配偶", spouses=["jianhua"]),
    dict(key="liu_fang", name="刘芳", gender="女", generation=4,
         birth_year=1954, hometown="山东省烟台市", residence="烟台市莱山区",
         contact="", rel="配偶", spouses=["jianye"]),
    dict(key="sun_li", name="孙丽", gender="女", generation=4,
         birth_year=1956, hometown="山东省威海市", residence="威海市环翠区",
         contact="", rel="配偶", spouses=["jianmin"]),
    dict(key="zhiyuan", name="陈志远", gender="男", generation=5, sibling_rank=1,
         birth_year=1975, hometown="山东省蓬莱县", residence="济南市高新区",
         contact="139 0000 0011", rel="血缘", father="jianguo", mother="wang_xiulan", spouses=["lin_jing"]),
    dict(key="zhigang", name="陈志刚", gender="男", generation=5, sibling_rank=2,
         birth_year=1978, hometown="山东省蓬莱县", residence="北京市朝阳区",
         contact="139 0000 0012", rel="血缘", father="jianguo", mother="wang_xiulan"),
    dict(key="zhimin", name="陈志敏", gender="女", generation=5, sibling_rank=3,
         birth_year=1980, hometown="山东省蓬莱县", residence="上海市徐汇区",
         contact="139 0000 0013", rel="血缘", father="jianguo", mother="wang_xiulan"),
    dict(key="zhiqiang", name="陈志强", gender="男", generation=5, sibling_rank=1,
         birth_year=1976, hometown="山东省蓬莱县", residence="青岛市崂山区",
         contact="139 0000 0014", rel="血缘", father="jianhua", mother="zhou_min", spouses=["xu_juan"]),
    dict(key="zhihong", name="陈志宏", gender="男", generation=5, sibling_rank=1,
         birth_year=1982, hometown="山东省蓬莱县", residence="烟台市莱山区",
         contact="139 0000 0015", rel="过继", father="jianye", mother="liu_fang"),
    dict(key="lin_jing", name="林静", gender="女", generation=5,
         birth_year=1978, hometown="山东省济南市", residence="济南市高新区",
         contact="", rel="配偶", spouses=["zhiyuan"]),
    dict(key="xu_juan", name="许娟", gender="女", generation=5,
         birth_year=1980, hometown="山东省青岛市", residence="青岛市崂山区",
         contact="", rel="配偶", spouses=["zhiqiang"]),
    dict(key="jiahe", name="陈嘉禾", gender="男", generation=6, sibling_rank=1,
         birth_year=2008, hometown="山东省济南市", residence="济南市高新区",
         contact="", rel="血缘", father="zhiyuan", mother="lin_jing"),
    dict(key="jiayi", name="陈嘉怡", gender="女", generation=6, sibling_rank=2,
         birth_year=2012, hometown="山东省济南市", residence="济南市高新区",
         contact="", rel="血缘", father="zhiyuan", mother="lin_jing"),
    dict(key="jianing", name="陈嘉宁", gender="女", generation=6, sibling_rank=3,
         birth_year=2015, hometown="山东省济南市", residence="济南市高新区",
         contact="", rel="收养", father="zhiyuan", mother="lin_jing"),
    dict(key="jiarui", name="陈嘉睿", gender="男", generation=6, sibling_rank=1,
         birth_year=2010, hometown="山东省青岛市", residence="青岛市崂山区",
         contact="", rel="血缘", father="zhiqiang", mother="xu_juan"),
]


def get_db():
    if "db" not in g:
        os.makedirs(DATA_DIR, exist_ok=True)
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        g.db = conn
    return g.db


@app.teardown_appcontext
def close_db(_):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def column_exists(db, table, column):
    rows = db.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r[1] == column for r in rows)


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row

    # 先补齐 v1 表结构中缺失的列，避免 SCHEMA 中索引创建失败
    members_exists = db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='members'"
    ).fetchone()
    if members_exists and not column_exists(db, "members", "genealogy_id"):
        db.execute("ALTER TABLE members ADD COLUMN genealogy_id INTEGER")
    if members_exists and not column_exists(db, "members", "zodiac"):
        db.execute("ALTER TABLE members ADD COLUMN zodiac TEXT")
    if members_exists and not column_exists(db, "members", "birthday"):
        db.execute("ALTER TABLE members ADD COLUMN birthday TEXT")
    if members_exists and not column_exists(db, "members", "birthday_type"):
        db.execute("ALTER TABLE members ADD COLUMN birthday_type TEXT")

    # v3：微信绑定 / 公开谱 / 用户-成员绑定
    if column_exists(db, "users", "username") and not column_exists(db, "users", "wechat_openid"):
        db.execute("ALTER TABLE users ADD COLUMN wechat_openid TEXT")
    if column_exists(db, "genealogies", "name") and not column_exists(db, "genealogies", "visibility"):
        db.execute("ALTER TABLE genealogies ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'")
    if column_exists(db, "genealogy_users", "role") and not column_exists(db, "genealogy_users", "member_id"):
        db.execute("ALTER TABLE genealogy_users ADD COLUMN member_id INTEGER")

    # v4：亲戚谱（独立族谱记录 + 节点复制来源）
    if column_exists(db, "genealogies", "name") and not column_exists(db, "genealogies", "kind"):
        db.execute("ALTER TABLE genealogies ADD COLUMN kind TEXT NOT NULL DEFAULT 'family'")
    if column_exists(db, "genealogies", "name") and not column_exists(db, "genealogies", "owner_user_id"):
        db.execute("ALTER TABLE genealogies ADD COLUMN owner_user_id INTEGER")
    if column_exists(db, "genealogies", "name") and not column_exists(db, "genealogies", "source_genealogy_id"):
        db.execute("ALTER TABLE genealogies ADD COLUMN source_genealogy_id INTEGER")
    if column_exists(db, "genealogies", "name") and not column_exists(db, "genealogies", "source_member_id"):
        db.execute("ALTER TABLE genealogies ADD COLUMN source_member_id INTEGER")
    if column_exists(db, "genealogies", "name") and not column_exists(db, "genealogies", "synced_at"):
        db.execute("ALTER TABLE genealogies ADD COLUMN synced_at TEXT")
    if members_exists and not column_exists(db, "members", "source_member_id"):
        db.execute("ALTER TABLE members ADD COLUMN source_member_id INTEGER")

    # v5：默认指引谱标记（任何登录用户可免加入查看）
    if column_exists(db, "genealogies", "name") and not column_exists(db, "genealogies", "is_default"):
        db.execute("ALTER TABLE genealogies ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0")

    db.executescript(SCHEMA)

    member_count = db.execute("SELECT COUNT(*) FROM members").fetchone()[0]

    # 情况一：全新库，无成员 → 灌入示例种子数据（同时创建默认谱与默认管理员）
    if member_count == 0:
        gid = ensure_default_genealogy(db)
        seed_database(db, gid)
        ensure_default_admin(db, gid)

    # 情况二：已有成员但未启用多谱 → 归入默认谱，并补建默认管理员
    else:
        gen_count = db.execute("SELECT COUNT(*) FROM genealogies").fetchone()[0]
        if gen_count == 0:
            gid = ensure_default_genealogy(db)
        else:
            gid = db.execute("SELECT id FROM genealogies ORDER BY id LIMIT 1").fetchone()["id"]
        db.execute("UPDATE members SET genealogy_id=? WHERE genealogy_id IS NULL", (gid,))
        ensure_default_admin(db, gid)

    # 标记默认指引谱：优先最早创建且无创建人的族谱，否则最早的族谱
    if not db.execute("SELECT 1 FROM genealogies WHERE is_default=1").fetchone():
        row = db.execute(
            "SELECT id FROM genealogies WHERE creator_id IS NULL ORDER BY id LIMIT 1"
        ).fetchone()
        if not row:
            row = db.execute("SELECT id FROM genealogies ORDER BY id LIMIT 1").fetchone()
        if row:
            db.execute("UPDATE genealogies SET is_default=1 WHERE id=?", (row["id"],))

    db.commit()
    db.close()


def ensure_default_genealogy(db):
    """若没有任何族谱，创建一份「默认家谱」作为已有数据的归属。"""
    row = db.execute("SELECT id FROM genealogies ORDER BY id LIMIT 1").fetchone()
    if row:
        return row["id"]
    cur = db.execute(
        "INSERT INTO genealogies (name, description, creator_id, is_default) VALUES (?, ?, NULL, 1)",
        ("默认家谱", "系统初始化时为既有成员创建的默认族谱"),
    )
    return cur.lastrowid


def ensure_default_admin(db, genealogy_id):
    """若本族谱没有任何成员，创建默认管理员 admin / admin123 并设为 admin。"""
    has_admin = db.execute(
        "SELECT 1 FROM genealogy_users WHERE genealogy_id=? AND role='admin'", (genealogy_id,)
    ).fetchone()
    if has_admin:
        return
    user = db.execute("SELECT id FROM users WHERE username='admin'").fetchone()
    if not user:
        cur = db.execute(
            "INSERT INTO users (username, password_hash, display_name) VALUES (?,?,?)",
            ("admin", generate_password_hash("admin123"), "系统管理员"),
        )
        uid = cur.lastrowid
    else:
        uid = user["id"]
    db.execute(
        "INSERT OR IGNORE INTO genealogy_users (genealogy_id, user_id, role) VALUES (?,?, 'admin')",
        (genealogy_id, uid),
    )


def seed_database(db, genealogy_id):
    key_to_id = {}
    gid = genealogy_id

    for p in SEED_PEOPLE:
        father_id = key_to_id.get(p.get("father"))
        mother_id = key_to_id.get(p.get("mother"))
        cur = db.execute(
            """INSERT INTO members
               (genealogy_id, code, name, gender, birth_year, death_year, hometown, sibling_rank,
                zodiac, generation, contact, residence, father_id, mother_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (gid, "pending", p["name"], p["gender"], p.get("birth_year"), p.get("death_year"),
             p.get("hometown"), p.get("sibling_rank"), p.get("zodiac", ""), p["generation"],
             p.get("contact", ""), p.get("residence", ""), father_id, mother_id),
        )
        mid = cur.lastrowid
        db.execute("UPDATE members SET code=? WHERE member_id=?", (f"M{mid:05d}", mid))
        key_to_id[p["key"]] = mid

    for p in SEED_PEOPLE:
        mid = key_to_id[p["key"]]
        spouse_ids = [key_to_id[s] for s in p.get("spouses", [])]
        db.execute(
            """INSERT INTO relations (member_id, relation_type, father_id, mother_id, spouse_array)
               VALUES (?,?,?,?,?)""",
            (mid, p.get("rel", "血缘"), key_to_id.get(p.get("father")),
             key_to_id.get(p.get("mother")),
             json.dumps([{"spouse_id": sid} for sid in spouse_ids], ensure_ascii=False)),
        )
    return key_to_id


# --------------------------------------------------------------------------
# 通用工具
# --------------------------------------------------------------------------
def row_to_dict(row):
    return {k: row[k] for k in row.keys()} if row is not None else None


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def parse_int(value, label, allow_none=True, low=None, high=None):
    if value in (None, "", "null"):
        if allow_none:
            return None
        raise ApiError(f"{label}不能为空")
    try:
        num = int(value)
    except (TypeError, ValueError):
        raise ApiError(f"{label}必须为整数")
    if low is not None and num < low:
        raise ApiError(f"{label}不能小于 {low}")
    if high is not None and num > high:
        raise ApiError(f"{label}不能大于 {high}")
    return num


LUNAR_MONTHS = ("正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "腊")
ZODIAC_ANIMALS = ("鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪")
LUNAR_DAYS = (
    "初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十",
    "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
    "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十",
)


def parse_date_text(value):
    """解析 YYYY-MM-DD，返回 (year, month, day)；非法返回 None。"""
    try:
        parts = str(value).strip().split("-")
        if len(parts) != 3:
            return None
        year, month, day = (int(x) for x in parts)
        datetime(year, month, day)
        return year, month, day
    except (TypeError, ValueError):
        return None


def zodiac_of_year(year):
    try:
        return ZODIAC_ANIMALS[(int(year) - 4) % 12]
    except (TypeError, ValueError):
        return ""


def zodiac_of_birthday(birthday, birthday_type):
    """按生日推算属相：优先用农历年份（阳历年初可能仍属上一个生肖年）。"""
    if not birthday:
        return ""
    info = birthday_info(birthday, birthday_type)
    lunar = info.get("birthday_lunar") or ""
    if lunar:
        return zodiac_of_year(lunar.split("-")[0])
    return zodiac_of_year(str(birthday).split("-")[0])


def lunar_label(year, month, day, leap=False):
    return f"{year}年{'闰' if leap else ''}{LUNAR_MONTHS[month - 1]}月{LUNAR_DAYS[day - 1]}"


def birthday_info(birthday, birthday_type):
    """返回生日原始值 + 阳历/农历互换结果（阳历按 YYYY-MM-DD，农历按 YYYY-MM-DD）。"""
    info = {
        "birthday": birthday or "",
        "birthday_type": birthday_type or "",
        "birthday_solar": "",
        "birthday_lunar": "",
        "birthday_text": "",
        "birthday_valid": True,
    }
    if not birthday:
        return info
    parsed = parse_date_text(birthday)
    if not parsed:
        info["birthday_valid"] = False
        info["birthday_text"] = "生日格式无效"
        return info
    if LunarDate is None:
        info["birthday_valid"] = False
        info["birthday_text"] = "服务器缺少 lunardate 组件，无法换算农历"
        return info
    year, month, day = parsed
    try:
        if birthday_type == "lunar":
            solar = LunarDate(year, month, day).to_solar_date()
            info["birthday_solar"] = solar.isoformat()
            info["birthday_lunar"] = f"{year}-{month:02d}-{day:02d}"
            info["birthday_text"] = f"农历 {lunar_label(year, month, day)}（阳历 {solar.isoformat()}）"
        else:
            solar_text = f"{year}-{month:02d}-{day:02d}"
            lunar = LunarDate.from_solar_date(year, month, day)
            info["birthday_solar"] = solar_text
            info["birthday_lunar"] = f"{lunar.year}-{lunar.month:02d}-{lunar.day:02d}"
            info["birthday_text"] = (
                f"阳历 {solar_text}（农历 {lunar_label(lunar.year, lunar.month, lunar.day, lunar.isLeapMonth)}）"
            )
    except (ValueError, OverflowError):
        info["birthday_valid"] = False
        label = "农历" if birthday_type == "lunar" else "阳历"
        info["birthday_text"] = f"{label} {birthday}（超出自动换算范围 1900—2099，仅保存原文）"
    return info


def spouse_ids_of(rel_row):
    if not rel_row:
        return []
    raw = rel_row["spouse_array"] or "[]"
    try:
        arr = json.loads(raw)
    except (TypeError, ValueError):
        return []
    ids = []
    for item in arr:
        sid = item.get("spouse_id") if isinstance(item, dict) else item
        try:
            sid = int(sid)
        except (TypeError, ValueError):
            continue
        if sid not in ids:
            ids.append(sid)
    return ids


def ensure_relation(db, member_id):
    row = db.execute("SELECT * FROM relations WHERE member_id=?", (member_id,)).fetchone()
    if row:
        return row
    db.execute(
        """INSERT INTO relations (member_id, relation_type, father_id, mother_id, spouse_array)
           VALUES (?, '血缘', NULL, NULL, '[]')""",
        (member_id,),
    )
    return db.execute("SELECT * FROM relations WHERE member_id=?", (member_id,)).fetchone()


def write_spouse_ids(db, member_id, ids):
    ensure_relation(db, member_id)
    payload = json.dumps([{"spouse_id": i} for i in sorted(set(ids))], ensure_ascii=False)
    db.execute("UPDATE relations SET spouse_array=? WHERE member_id=?", (payload, member_id))


def remove_spouse_link(db, member_id, other_id):
    ids = [i for i in spouse_ids_of(ensure_relation(db, other_id)) if i != member_id]
    write_spouse_ids(db, other_id, ids)


def add_spouse_link(db, member_id, other_id):
    ids = spouse_ids_of(ensure_relation(db, other_id))
    if member_id not in ids:
        ids.append(member_id)
        write_spouse_ids(db, other_id, ids)


def sync_spouses(db, member_id, new_ids):
    old_ids = set(spouse_ids_of(ensure_relation(db, member_id)))
    new_ids = set(new_ids)
    new_ids.discard(member_id)
    for sid in old_ids - new_ids:
        remove_spouse_link(db, member_id, sid)
    for sid in new_ids - old_ids:
        add_spouse_link(db, member_id, sid)
    write_spouse_ids(db, member_id, new_ids)


def ancestor_ids(db, member_id, limit=64):
    seen = set()
    stack = [member_id]
    while stack and len(seen) < limit:
        cur = stack.pop()
        row = db.execute("SELECT father_id, mother_id FROM members WHERE member_id=?", (cur,)).fetchone()
        if not row:
            continue
        for pid in (row["father_id"], row["mother_id"]):
            if pid and pid not in seen:
                seen.add(pid)
                stack.append(pid)
    return seen


def brief(db, member_id):
    row = db.execute(
        "SELECT member_id AS id, code, name, gender, generation, birth_year, death_year, photo "
        "FROM members WHERE member_id=?",
        (member_id,),
    ).fetchone()
    return row_to_dict(row) if row else None


def next_sibling_rank(db, father_id, mother_id, exclude_id=None, genealogy_id=None):
    conditions = []
    params = []
    if father_id:
        conditions.append("father_id = ?")
        params.append(father_id)
    if mother_id:
        conditions.append("mother_id = ?")
        params.append(mother_id)
    if not conditions:
        return None
    sql = "SELECT COALESCE(MAX(sibling_rank), 0) AS mx FROM members WHERE (" + " OR ".join(conditions) + ")"
    if exclude_id:
        sql += " AND member_id <> ?"
        params.append(exclude_id)
    row = db.execute(sql, params).fetchone()
    return (row["mx"] or 0) + 1


def refresh_sibling_ranks(db, genealogy_id):
    """按出生年重排兄弟姐妹：有出生年的按年升序在前，未注明的排在后面；结果写入 sibling_rank。"""
    rows = db.execute(
        """SELECT member_id, father_id, mother_id, birth_year, sibling_rank
           FROM members WHERE genealogy_id=?""",
        (genealogy_id,),
    ).fetchall()
    groups = {}
    for row in rows:
        if row["father_id"]:
            key = ("father", row["father_id"])
        elif row["mother_id"]:
            key = ("mother", row["mother_id"])
        else:
            continue
        groups.setdefault(key, []).append(row)
    for items in groups.values():
        if len(items) < 2:
            continue
        items.sort(key=lambda r: (
            r["birth_year"] is None, r["birth_year"] or 0,
            r["sibling_rank"] is None, r["sibling_rank"] or 0, r["member_id"],
        ))
        for index, row in enumerate(items, 1):
            if row["sibling_rank"] != index:
                db.execute("UPDATE members SET sibling_rank=? WHERE member_id=?",
                           (index, row["member_id"]))


def cascade_descendant_generations(db, genealogy_id, root_id):
    """祖先的父母/代际变更后，沿父子链重算后代代际，避免子代与父代同代。"""
    queue = deque([root_id])
    seen = {root_id}
    while queue:
        parent_id = queue.popleft()
        children = db.execute(
            """SELECT c.member_id, c.generation,
                      (SELECT generation FROM members WHERE member_id=c.father_id) AS fg,
                      (SELECT generation FROM members WHERE member_id=c.mother_id) AS mg
               FROM members c
               WHERE c.genealogy_id=? AND (c.father_id=? OR c.mother_id=?)""",
            (genealogy_id, parent_id, parent_id),
        ).fetchall()
        for child in children:
            child_id = child["member_id"]
            if child_id in seen:
                continue
            seen.add(child_id)
            parent_generations = [gen for gen in (child["fg"], child["mg"]) if gen]
            if not parent_generations:
                continue
            target = max(parent_generations) + 1
            if child["generation"] != target:
                db.execute(
                    "UPDATE members SET generation=?, updated_at=? WHERE member_id=?",
                    (target, now_str(), child_id),
                )
            queue.append(child_id)


# --------------------------------------------------------------------------
# 认证与权限
# --------------------------------------------------------------------------
def get_token():
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return request.cookies.get("auth_token", "")


def current_user_row():
    token = get_token()
    if not token:
        return None
    db = get_db()
    row = db.execute(
        """SELECT u.* FROM tokens t JOIN users u ON u.id = t.user_id
           WHERE t.token = ? AND t.expires_at > datetime('now', 'localtime')""",
        (token,),
    ).fetchone()
    return row


def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        row = current_user_row()
        if not row:
            return jsonify(ok=False, error="未登录或登录已过期，请重新登录"), 401
        g.user = row_to_dict(row)
        return f(*args, **kwargs)
    return wrapper


def require_genealogy_role(role):
    """要求在当前族谱中至少拥有指定角色（admin > branch_admin > normal）。"""
    def decorator(f):
        @wraps(f)
        def wrapper(*args, **kwargs):
            gid = kwargs.get("genealogy_id")
            if gid is None:
                gid = request.args.get("genealogy_id") or request.view_args.get("genealogy_id")
            try:
                gid = int(gid)
            except (TypeError, ValueError):
                raise ApiError("族谱参数无效", 400)
            db = get_db()
            row = db.execute(
                "SELECT role FROM genealogy_users WHERE genealogy_id=? AND user_id=?",
                (gid, g.user["id"]),
            ).fetchone()
            if not row:
                raise ApiError("您没有该族谱的访问权限", 403)
            g.genealogy_id = gid
            g.role = row["role"]
            if ROLE_RANK.get(g.role, 0) < ROLE_RANK.get(role, 0):
                raise ApiError("权限不足，需要管理员权限", 403)
            return f(*args, **kwargs)
        return wrapper
    return decorator


def require_genealogy_read(f):
    """读权限：成员按原角色；非成员仅当族谱公开时可读脱敏内容（g.public_only=True）。"""
    @wraps(f)
    def wrapper(*args, **kwargs):
        gid = kwargs.get("genealogy_id")
        try:
            gid = int(gid)
        except (TypeError, ValueError):
            raise ApiError("族谱参数无效", 400)
        db = get_db()
        gen = db.execute("SELECT visibility, is_default FROM genealogies WHERE id=?", (gid,)).fetchone()
        if not gen:
            raise ApiError("族谱不存在", 404)
        row = db.execute(
            "SELECT role FROM genealogy_users WHERE genealogy_id=? AND user_id=?",
            (gid, g.user["id"]),
        ).fetchone()
        g.genealogy_id = gid
        g.public_only = False
        if row:
            g.role = row["role"]
        elif gen["visibility"] == "public" or gen["is_default"]:
            g.role = None
            g.public_only = True
        else:
            raise ApiError("您没有该族谱的访问权限", 403)
        return f(*args, **kwargs)
    return wrapper


# --------------------------------------------------------------------------
# 前端静态页
# --------------------------------------------------------------------------
@app.get("/static/uploads/<path:name>")
def serve_upload(name):
    """上传目录可能位于项目外（如 CFS 挂载），单独提供访问。"""
    return send_from_directory(UPLOAD_DIR, name)


@app.get("/")
def index():
    return send_from_directory(os.path.join(BASE_DIR, "static"), "index.html")


@app.get("/login")
def login_page():
    return send_from_directory(os.path.join(BASE_DIR, "static"), "login.html")


@app.get("/home")
def home_page():
    return send_from_directory(os.path.join(BASE_DIR, "static"), "home.html")


@app.get("/me")
def me_page():
    return send_from_directory(os.path.join(BASE_DIR, "static"), "me.html")


# --------------------------------------------------------------------------
# 认证接口
# --------------------------------------------------------------------------
def public_user(row):
    """用户公开字段：绝不下发密码哈希与微信 openid。"""
    data = dict(row)
    data.pop("password_hash", None)
    openid = data.pop("wechat_openid", None)
    data["wechat_bound"] = bool(openid)
    return data


def issue_token(db, user_row):
    """签发登录 token，写 Cookie，返回与密码登录一致的响应结构。"""
    token = secrets.token_urlsafe(24)
    expires = (datetime.now() + timedelta(days=TOKEN_TTL_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
    db.execute("INSERT INTO tokens (token, user_id, expires_at) VALUES (?,?,?)", (token, user_row["id"], expires))
    db.commit()
    try:
        ensure_kinship(db, user_row["id"])
    except sqlite3.Error:
        db.rollback()  # 亲戚谱同步失败不应阻断登录
    resp = jsonify(ok=True, data={"token": token, "user": public_user(user_row), "expires_at": expires})
    resp.set_cookie("auth_token", token, httponly=True, samesite="Lax", max_age=TOKEN_TTL_DAYS * 86400)
    return resp


def wechat_openid_from_code(code):
    """配置 AppID/Secret 时走真实 jscode2session；均未配置时为本地 mock（code 即 openid）。"""
    code = (code or "").strip()
    if not code:
        raise ApiError("缺少微信登录 code")
    if WECHAT_APP_ID and WECHAT_APP_SECRET:
        query = urlencode({
            "appid": WECHAT_APP_ID, "secret": WECHAT_APP_SECRET,
            "js_code": code, "grant_type": "authorization_code",
        })
        try:
            with urlopen("https://api.weixin.qq.com/sns/jscode2session?" + query, timeout=8) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except (URLError, OSError, ValueError):
            raise ApiError("微信登录服务暂时不可用，请稍后重试", 502)
        openid = (payload or {}).get("openid")
        if not openid:
            errmsg = (payload or {}).get("errmsg") or "未获取到 openid"
            raise ApiError(f"微信登录失败：{errmsg}", 400)
        return openid
    if WECHAT_APP_ID or WECHAT_APP_SECRET:
        raise ApiError("微信登录配置不完整，需同时设置 WECHAT_APP_ID 与 WECHAT_APP_SECRET", 500)
    return code


@app.post("/api/auth/register")
def api_register():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    display_name = (data.get("display_name") or "").strip() or username
    if len(username) < 2 or len(username) > 32:
        raise ApiError("用户名需 2—32 个字符")
    if len(password) < 6:
        raise ApiError("密码至少 6 位")
    db = get_db()
    if db.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
        raise ApiError("用户名已被占用")
    cur = db.execute(
        "INSERT INTO users (username, password_hash, display_name) VALUES (?,?,?)",
        (username, generate_password_hash(password), display_name),
    )
    db.commit()
    return jsonify(ok=True, data={"id": cur.lastrowid, "username": username, "display_name": display_name})


@app.post("/api/auth/login")
def api_login():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    if not row or not check_password_hash(row["password_hash"], password):
        raise ApiError("用户名或密码错误", 401)
    return issue_token(db, row)


@app.post("/api/auth/wechat/login")
def api_wechat_login():
    data = request.get_json(silent=True) or {}
    openid = wechat_openid_from_code(data.get("code"))
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE wechat_openid=?", (openid,)).fetchone()
    if not row:
        # 首次微信登录自动建档：随机用户名 + 随机不可用密码（该列 NOT NULL）
        username = "wx_" + secrets.token_hex(6)
        while db.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
            username = "wx_" + secrets.token_hex(6)
        display_name = "微信用户" + secrets.token_hex(2)
        try:
            db.execute(
                "INSERT INTO users (username, password_hash, display_name, wechat_openid) VALUES (?,?,?,?)",
                (username, generate_password_hash(secrets.token_urlsafe(24)), display_name, openid),
            )
            db.commit()
        except sqlite3.IntegrityError:
            db.rollback()  # 并发下已被其他请求创建，按已存在账号登录
        row = db.execute("SELECT * FROM users WHERE wechat_openid=?", (openid,)).fetchone()
        if not row:
            raise ApiError("微信账号创建失败，请重试", 500)
    return issue_token(db, row)


@app.post("/api/auth/wechat/bind")
@login_required
def api_wechat_bind():
    data = request.get_json(silent=True) or {}
    openid = wechat_openid_from_code(data.get("code"))
    db = get_db()
    if g.user.get("wechat_openid"):
        if g.user["wechat_openid"] == openid:
            return jsonify(ok=True, data={"wechat_bound": True})
        raise ApiError("当前账号已绑定其他微信", 409)
    other = db.execute("SELECT id FROM users WHERE wechat_openid=?", (openid,)).fetchone()
    if other and other["id"] != g.user["id"]:
        raise ApiError("该微信已绑定其他账号", 409)
    db.execute("UPDATE users SET wechat_openid=? WHERE id=?", (openid, g.user["id"]))
    db.commit()
    return jsonify(ok=True, data={"wechat_bound": True})


@app.post("/api/auth/logout")
@login_required
def api_logout():
    token = get_token()
    if token:
        get_db().execute("DELETE FROM tokens WHERE token=?", (token,))
        get_db().commit()
    resp = jsonify(ok=True)
    resp.delete_cookie("auth_token")
    return resp


@app.get("/api/auth/me")
@login_required
def api_me():
    db = get_db()
    rows = db.execute(
        """SELECT gg.*, gu.role, gu.member_id,
                  m.name AS member_name, m.generation AS member_generation
           FROM genealogies gg
           JOIN genealogy_users gu ON gu.genealogy_id = gg.id
           LEFT JOIN members m ON m.member_id = gu.member_id
           WHERE gu.user_id = ?
           ORDER BY CASE gu.role WHEN 'admin' THEN 0 WHEN 'branch_admin' THEN 1 ELSE 2 END,
                    gg.created_at DESC""",
        (g.user["id"],),
    ).fetchall()
    genealogies = []
    for r in rows:
        d = row_to_dict(r)
        d["member_count"] = db.execute(
            "SELECT COUNT(*) FROM members WHERE genealogy_id=?", (r["id"],)).fetchone()[0]
        genealogies.append(d)
    user = public_user(g.user)
    # 手机号暂未接入，前端统一按未绑定展示
    user["phone"] = None
    return jsonify(ok=True, data={
        "user": user,
        "genealogies": genealogies,
        "managed": [d for d in genealogies if d["role"] == "admin"],
        "identities": [d for d in genealogies if d.get("member_id")],
    })


# --------------------------------------------------------------------------
# 族谱接口
# --------------------------------------------------------------------------
@app.get("/api/genealogies/public")
@login_required
def api_public_genealogies():
    """公开族谱列表：任何登录用户可见（含未加入者），附带我的加入/申请状态。"""
    db = get_db()
    rows = db.execute(
        "SELECT * FROM genealogies WHERE kind='family' AND (visibility='public' OR is_default=1) "
        "ORDER BY is_default DESC, created_at DESC"
    ).fetchall()
    data = []
    for r in rows:
        d = row_to_dict(r)
        d["member_count"] = db.execute(
            "SELECT COUNT(*) FROM members WHERE genealogy_id=?", (r["id"],)).fetchone()[0]
        d["generation_count"] = db.execute(
            "SELECT COALESCE(MAX(generation),0) FROM members WHERE genealogy_id=?", (r["id"],)).fetchone()[0]
        d["is_member"] = bool(db.execute(
            "SELECT 1 FROM genealogy_users WHERE genealogy_id=? AND user_id=?",
            (r["id"], g.user["id"])).fetchone())
        pending = db.execute(
            """SELECT id, payload FROM proposals
               WHERE genealogy_id=? AND proposer_id=? AND action='join_bind' AND status='pending'""",
            (r["id"], g.user["id"])).fetchone()
        d["pending_join"] = None
        if pending:
            try:
                mid = json.loads(pending["payload"]).get("member_id")
            except (TypeError, ValueError):
                mid = None
            d["pending_join"] = {"proposal_id": pending["id"], "member_id": mid}
        data.append(d)
    return jsonify(ok=True, data=data)


@app.get("/api/genealogies")
@login_required
def api_genealogies():
    db = get_db()
    rows = db.execute(
        """SELECT gg.*, gu.role, gu.member_id,
                  m.name AS member_name, m.generation AS member_generation
           FROM genealogies gg
           JOIN genealogy_users gu ON gu.genealogy_id = gg.id
           LEFT JOIN members m ON m.member_id = gu.member_id
           WHERE gu.user_id = ?
           ORDER BY gg.created_at DESC""",
        (g.user["id"],),
    ).fetchall()
    data = []
    for r in rows:
        d = row_to_dict(r)
        d["member_count"] = db.execute(
            "SELECT COUNT(*) FROM members WHERE genealogy_id=?", (r["id"],)).fetchone()[0]
        data.append(d)
    return jsonify(ok=True, data=data)


@app.post("/api/genealogies")
@login_required
def api_genealogy_create():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    description = (data.get("description") or "").strip()
    if not name:
        raise ApiError("请填写族谱名称")
    if len(name) > 60:
        raise ApiError("族谱名称不超过 60 个字符")
    db = get_db()
    cur = db.execute(
        "INSERT INTO genealogies (name, description, creator_id) VALUES (?,?,?)",
        (name, description, g.user["id"]),
    )
    gid = cur.lastrowid
    db.execute(
        "INSERT INTO genealogy_users (genealogy_id, user_id, role) VALUES (?,?, 'admin')",
        (gid, g.user["id"]),
    )
    db.commit()
    return jsonify(ok=True, data={"id": gid, "name": name, "role": "admin"}), 201


@app.get("/api/genealogies/<int:genealogy_id>")
@login_required
def api_genealogy_detail(genealogy_id):
    db = get_db()
    gen = db.execute("SELECT * FROM genealogies WHERE id=?", (genealogy_id,)).fetchone()
    if not gen:
        raise ApiError("族谱不存在", 404)
    role_row = db.execute(
        "SELECT role, member_id FROM genealogy_users WHERE genealogy_id=? AND user_id=?",
        (genealogy_id, g.user["id"]),
    ).fetchone()
    if not role_row and not gen["is_default"] and gen["visibility"] != "public":
        raise ApiError("您没有该族谱的访问权限", 403)
    data = row_to_dict(gen)
    if not role_row:
        # 公开谱/默认谱的访客：只返回展示所需的脱敏信息
        data["creator_id"] = None
        data["owner_user_id"] = None
    data["role"] = role_row["role"] if role_row else None
    data["my_member_id"] = role_row["member_id"] if role_row else None
    data["my_member_name"] = None
    data["my_member_generation"] = None
    if role_row and role_row["member_id"]:
        mine = db.execute(
            "SELECT name, generation FROM members WHERE member_id=?",
            (role_row["member_id"],),
        ).fetchone()
        if mine:
            data["my_member_name"] = mine["name"]
            data["my_member_generation"] = mine["generation"]
    data["member_count"] = db.execute(
        "SELECT COUNT(*) FROM members WHERE genealogy_id=?", (genealogy_id,)).fetchone()[0]
    data["max_generation"] = db.execute(
        "SELECT COALESCE(MAX(generation),0) FROM members WHERE genealogy_id=?", (genealogy_id,)).fetchone()[0]
    return jsonify(ok=True, data=data)


def ensure_family_genealogy(db, genealogy_id, message="亲戚谱不支持该操作"):
    """亲戚谱（kind='kinship'）只允许成员增删改，禁止公开、转让、加人等操作。"""
    row = db.execute("SELECT kind FROM genealogies WHERE id=?", (genealogy_id,)).fetchone()
    if row and row["kind"] == "kinship":
        raise ApiError(message, 403)


@app.put("/api/genealogies/<int:genealogy_id>/visibility")
@login_required
@require_genealogy_role("admin")
def api_genealogy_visibility(genealogy_id):
    """公开 / 私密切换，仅本谱管理员可操作。"""
    data = request.get_json(silent=True) or {}
    visibility = (data.get("visibility") or "").strip()
    if visibility not in ("public", "private"):
        raise ApiError("可见性只能是 public（公开）或 private（私密）")
    db = get_db()
    ensure_family_genealogy(db, genealogy_id, "亲戚谱不支持公开或私密切换")
    db.execute("UPDATE genealogies SET visibility=? WHERE id=?", (visibility, genealogy_id))
    db.commit()
    return jsonify(ok=True, data={"id": genealogy_id, "visibility": visibility})


@app.post("/api/genealogies/<int:genealogy_id>/transfer")
@login_required
@require_genealogy_role("admin")
def api_genealogy_transfer(genealogy_id):
    data = request.get_json(silent=True) or {}
    new_admin_id = parse_int(data.get("new_admin_id"), "新管理员", allow_none=False)
    db = get_db()
    ensure_family_genealogy(db, genealogy_id, "亲戚谱不支持转让")
    if new_admin_id == g.user["id"]:
        raise ApiError("新管理员不能是当前管理员")
    exists = db.execute(
        "SELECT 1 FROM genealogy_users WHERE genealogy_id=? AND user_id=?",
        (genealogy_id, new_admin_id),
    ).fetchone()
    if not exists:
        raise ApiError("该用户尚未加入本族谱，无法转让")
    db.execute(
        "UPDATE genealogy_users SET role='normal' WHERE genealogy_id=? AND role='admin'",
        (genealogy_id,),
    )
    db.execute(
        "UPDATE genealogy_users SET role='admin' WHERE genealogy_id=? AND user_id=?",
        (genealogy_id, new_admin_id),
    )
    db.execute("UPDATE genealogies SET creator_id=? WHERE id=?", (new_admin_id, genealogy_id))
    db.commit()
    new_admin = db.execute("SELECT display_name, username FROM users WHERE id=?", (new_admin_id,)).fetchone()
    return jsonify(ok=True, data={"new_admin": new_admin["display_name"] or new_admin["username"]})


# 族谱成员管理
@app.get("/api/genealogies/<int:genealogy_id>/users")
@login_required
@require_genealogy_role("normal")
def api_genealogy_users(genealogy_id):
    db = get_db()
    rows = db.execute(
        """SELECT gu.user_id, gu.role, gu.member_id, u.username, u.display_name, gg.creator_id,
                  m.name AS member_name
           FROM genealogy_users gu
           JOIN users u ON u.id = gu.user_id
           JOIN genealogies gg ON gg.id = gu.genealogy_id
           LEFT JOIN members m ON m.member_id = gu.member_id
           WHERE gu.genealogy_id = ?
           ORDER BY CASE gu.role WHEN 'admin' THEN 1 WHEN 'branch_admin' THEN 2 ELSE 3 END, u.username""",
        (genealogy_id,),
    ).fetchall()
    return jsonify(ok=True, data=[row_to_dict(r) for r in rows])


@app.post("/api/genealogies/<int:genealogy_id>/users")
@login_required
@require_genealogy_role("admin")
def api_genealogy_add_user(genealogy_id):
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    role = (data.get("role") or "normal").strip()
    if role not in ROLES:
        raise ApiError("角色只能是 admin / branch_admin / normal")
    db = get_db()
    ensure_family_genealogy(db, genealogy_id, "亲戚谱不支持添加协作者")
    user = db.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    if not user:
        raise ApiError(f"用户 {username} 不存在，请先让其注册")
    uid = user["id"]
    existing = db.execute(
        "SELECT 1 FROM genealogy_users WHERE genealogy_id=? AND user_id=?",
        (genealogy_id, uid),
    ).fetchone()
    if existing:
        raise ApiError("该用户已在本族谱中")
    if role == "admin":
        raise ApiError("不能直接添加管理员，管理员只能通过转让产生")
    db.execute(
        "INSERT INTO genealogy_users (genealogy_id, user_id, role) VALUES (?,?,?)",
        (genealogy_id, uid, role),
    )
    db.commit()
    return jsonify(ok=True)


@app.put("/api/genealogies/<int:genealogy_id>/users/<int:user_id>")
@login_required
@require_genealogy_role("admin")
def api_genealogy_update_user(genealogy_id, user_id):
    data = request.get_json(silent=True) or {}
    db = get_db()
    gen = db.execute("SELECT kind FROM genealogies WHERE id=?", (genealogy_id,)).fetchone()
    if gen and gen["kind"] == "kinship":
        raise ApiError("亲戚谱不支持调整成员权限", 403)
    target = db.execute("SELECT * FROM genealogy_users WHERE genealogy_id=? AND user_id=?",
                        (genealogy_id, user_id)).fetchone()
    if not target:
        raise ApiError("该用户不在本族谱中", 404)
    if "role" in data:
        role = (data.get("role") or "normal").strip()
        if role not in ROLES:
            raise ApiError("角色无效")
        if user_id == g.user["id"]:
            raise ApiError("不能修改自身角色，管理员变更请使用转让功能")
        if role == "admin":
            raise ApiError("不能直接设为管理员，请使用管理员转让")
        db.execute(
            "UPDATE genealogy_users SET role=? WHERE genealogy_id=? AND user_id=?",
            (role, genealogy_id, user_id),
        )
    if "member_id" in data:
        # 绑定 / 改绑 / 解绑（null），仅管理员可操作（路由已限定 admin）
        member_id = parse_int(data.get("member_id"), "绑定成员")
        if member_id is not None:
            member = db.execute("SELECT member_id FROM members WHERE member_id=? AND genealogy_id=?",
                                (member_id, genealogy_id)).fetchone()
            if not member:
                raise ApiError("目标成员不在该族谱中", 400)
            occupied = db.execute(
                "SELECT user_id FROM genealogy_users WHERE genealogy_id=? AND member_id=? AND user_id<>?",
                (genealogy_id, member_id, user_id)).fetchone()
            if occupied:
                raise ApiError("该成员已绑定其他账号", 409)
        try:
            db.execute(
                "UPDATE genealogy_users SET member_id=? WHERE genealogy_id=? AND user_id=?",
                (member_id, genealogy_id, user_id),
            )
        except sqlite3.IntegrityError:
            db.rollback()
            raise ApiError("该成员已绑定其他账号", 409)
    db.commit()
    if "member_id" in data:
        ensure_kinship(db, user_id)
    return jsonify(ok=True)


@app.post("/api/genealogies/<int:genealogy_id>/bind-member")
@login_required
@require_genealogy_role("normal")
def api_bind_self_member(genealogy_id):
    """当前账号首次绑定自身族谱身份；已绑定后仅管理员可改绑。"""
    data = request.get_json(silent=True) or {}
    member_id = parse_int(data.get("member_id"), "绑定成员")
    if member_id is None:
        raise ApiError("请选择要绑定的谱成员")
    db = get_db()
    gen = db.execute("SELECT kind FROM genealogies WHERE id=?", (genealogy_id,)).fetchone()
    if gen and gen["kind"] == "kinship":
        raise ApiError("亲戚谱不支持绑定身份，请在家谱中绑定", 403)
    row = db.execute(
        "SELECT member_id FROM genealogy_users WHERE genealogy_id=? AND user_id=?",
        (genealogy_id, g.user["id"]),
    ).fetchone()
    if row and row["member_id"] is not None:
        raise ApiError("您已绑定身份，如需更改请联系管理员", 403)
    member = db.execute(
        "SELECT member_id, name, generation FROM members WHERE member_id=? AND genealogy_id=?",
        (member_id, genealogy_id),
    ).fetchone()
    if not member:
        raise ApiError("目标成员不在该族谱中", 400)
    occupied = db.execute(
        "SELECT user_id FROM genealogy_users WHERE genealogy_id=? AND member_id=?",
        (genealogy_id, member_id),
    ).fetchone()
    if occupied:
        raise ApiError("该成员已绑定其他账号", 409)
    try:
        db.execute(
            "UPDATE genealogy_users SET member_id=? WHERE genealogy_id=? AND user_id=?",
            (member_id, genealogy_id, g.user["id"]),
        )
        db.commit()
    except sqlite3.IntegrityError:
        db.rollback()
        raise ApiError("该成员已绑定其他账号", 409)
    ensure_kinship(db, g.user["id"])
    return jsonify(ok=True, data={
        "member_id": member_id,
        "member_name": member["name"],
        "generation": member["generation"],
    })


@app.delete("/api/genealogies/<int:genealogy_id>/users/<int:user_id>")
@login_required
@require_genealogy_role("admin")
def api_genealogy_remove_user(genealogy_id, user_id):
    if user_id == g.user["id"]:
        raise ApiError("不能移除自己")
    db = get_db()
    kin = db.execute("SELECT kind, owner_user_id FROM genealogies WHERE id=?", (genealogy_id,)).fetchone()
    if kin and kin["kind"] == "kinship":
        raise ApiError("亲戚谱成员由本人与源家谱管理员组成，不支持移除", 403)
    db.execute(
        "DELETE FROM genealogy_users WHERE genealogy_id=? AND user_id=?",
        (genealogy_id, user_id),
    )
    db.commit()
    return jsonify(ok=True)


# --------------------------------------------------------------------------
# 成员校验（带族谱范围）
# --------------------------------------------------------------------------
def validate_member(data, db, genealogy_id, member_id=None, current_generation=None):
    name = (data.get("name") or "").strip()
    if not name:
        raise ApiError("姓名不能为空")
    if len(name) > 40:
        raise ApiError("姓名长度不能超过 40 个字符")
    gender = (data.get("gender") or "男").strip()
    if gender not in GENDERS:
        raise ApiError("性别只能是 男 或 女")
    code = (data.get("code") or "").strip()
    if code and len(code) > 32:
        raise ApiError("唯一编码不能超过 32 个字符")
    if code:
        clash = db.execute("SELECT member_id FROM members WHERE code=?", (code,)).fetchone()
        if clash and clash["member_id"] != member_id:
            raise ApiError(f"唯一编码 {code} 已被使用")
    birth_year = parse_int(data.get("birth_year"), "出生年", low=1000, high=2100)
    death_year = parse_int(data.get("death_year"), "去世年", low=1000, high=2100)
    if birth_year and death_year and death_year < birth_year:
        raise ApiError("去世年不能早于出生年")
    birthday = str(data.get("birthday") or "").strip()
    birthday_type = str(data.get("birthday_type") or "").strip()
    if birthday:
        if not parse_date_text(birthday):
            raise ApiError("生日格式应为 YYYY-MM-DD")
        if birthday_type not in BIRTHDAY_TYPES:
            birthday_type = "solar"
    else:
        birthday = ""
        birthday_type = ""
    generation = parse_int(data.get("generation"), "代际", low=1, high=MAX_GENERATIONS)
    sibling_rank = parse_int(data.get("sibling_rank"), "排行", low=1, high=99)
    contact = (data.get("contact") or "").strip()[:80]
    hometown = (data.get("hometown") or "").strip()[:80]
    zodiac = str(data.get("zodiac") or "").strip()[:10]
    if birthday:
        computed_zodiac = zodiac_of_birthday(birthday, birthday_type)
        if computed_zodiac:
            zodiac = computed_zodiac
    residence = (data.get("residence") or "").strip()[:120]
    photo = (data.get("photo") or "").strip()[:2048]
    rel_type = (data.get("relation_type") or "血缘").strip()
    if rel_type not in REL_TYPES:
        raise ApiError("关系类型只能是 血缘 / 配偶 / 收养 / 过继")
    father_id = parse_int(data.get("father_id"), "父亲")
    mother_id = parse_int(data.get("mother_id"), "母亲")
    for pid, label in ((father_id, "父亲"), (mother_id, "母亲")):
        if pid is None:
            continue
        if member_id is not None and pid == member_id:
            raise ApiError(f"{label}不能选择本人")
        prow = db.execute("SELECT genealogy_id FROM members WHERE member_id=?", (pid,)).fetchone()
        if not prow:
            raise ApiError(f"{label}节点不存在")
        if prow["genealogy_id"] != genealogy_id:
            raise ApiError(f"{label}节点不在当前族谱中")
        if member_id is not None and member_id in ancestor_ids(db, pid):
            raise ApiError(f"{label}节点不能是自己的后代")
    spouse_ids = data.get("spouse_ids") or []
    if not isinstance(spouse_ids, list):
        raise ApiError("配偶列表格式不正确")
    cleaned = []
    for sid in spouse_ids:
        try:
            sid = int(sid)
        except (TypeError, ValueError):
            continue
        if member_id is not None and sid == member_id:
            raise ApiError("配偶不能选择本人")
        if sid and sid not in cleaned:
            srow = db.execute("SELECT genealogy_id FROM members WHERE member_id=?", (sid,)).fetchone()
            if not srow:
                raise ApiError(f"配偶节点不存在")
            if srow["genealogy_id"] != genealogy_id:
                raise ApiError(f"配偶节点不在当前族谱中")
            if member_id is not None:
                if sid in ancestor_ids(db, member_id):
                    raise ApiError("配偶不能选择本人的长辈")
                if member_id in ancestor_ids(db, sid):
                    raise ApiError("配偶不能选择本人的晚辈")
            cleaned.append(sid)
    father_gen = mother_gen = None
    if father_id:
        father_gen = db.execute("SELECT generation FROM members WHERE member_id=?", (father_id,)).fetchone()["generation"]
    if mother_id:
        mother_gen = db.execute("SELECT generation FROM members WHERE member_id=?", (mother_id,)).fetchone()["generation"]
    parent_gen = max([x for x in (father_gen, mother_gen) if x is not None], default=None)
    if parent_gen is not None:
        # 选择了父/母节点时，代际固定为其代际 + 1
        generation = parent_gen + 1
    elif generation is None:
        # 未填代际且关联了配偶时，自动与配偶同代（夫妻同辈）
        spouse_gen = None
        for sid in cleaned:
            srow = db.execute("SELECT generation FROM members WHERE member_id=?", (sid,)).fetchone()
            if srow and srow["generation"]:
                spouse_gen = srow["generation"]
                break
        if spouse_gen is not None:
            generation = spouse_gen
        elif current_generation is not None:
            generation = current_generation
        elif member_id is None:
            generation = 1
    if generation is not None and generation > MAX_GENERATIONS:
        raise ApiError(f"家谱最多收录 {MAX_GENERATIONS} 代")
    if generation is None:
        generation = 1
    return dict(
        name=name, gender=gender, code=code, birth_year=birth_year, death_year=death_year,
        birthday=birthday, birthday_type=birthday_type,
        hometown=hometown, residence=residence, contact=contact, photo=photo,
        zodiac=zodiac, generation=generation, sibling_rank=sibling_rank,
        father_id=father_id, mother_id=mother_id, relation_type=rel_type, spouse_ids=cleaned,
    )


def full_member(db, member_id):
    row = db.execute(
        """SELECT m.*, r.relation_id, r.relation_type, r.spouse_array
           FROM members m LEFT JOIN relations r ON r.member_id = m.member_id
           WHERE m.member_id=?""",
        (member_id,),
    ).fetchone()
    if not row:
        raise ApiError("成员不存在", 404)
    data = row_to_dict(row)
    data.update(birthday_info(data.get("birthday"), data.get("birthday_type")))
    data["spouse_ids"] = spouse_ids_of(row)
    data["spouses"] = [brief(db, sid) for sid in data["spouse_ids"] if brief(db, sid)]
    data["father"] = brief(db, row["father_id"]) if row["father_id"] else None
    data["mother"] = brief(db, row["mother_id"]) if row["mother_id"] else None
    data["children"] = [
        brief(db, r["member_id"]) for r in db.execute(
            "SELECT member_id FROM members WHERE father_id=? OR mother_id=? ORDER BY "
            "sibling_rank IS NULL, sibling_rank, birth_year IS NULL, birth_year, member_id",
            (member_id, member_id),
        )
    ]
    return data


def insert_member(db, genealogy_id, payload):
    if payload["sibling_rank"] is None:
        payload["sibling_rank"] = next_sibling_rank(db, payload["father_id"], payload["mother_id"], genealogy_id=genealogy_id)
    ts = now_str()
    cur = db.execute(
        """INSERT INTO members
           (genealogy_id, code, name, gender, birth_year, death_year, birthday, birthday_type,
            hometown, sibling_rank, zodiac, generation, contact, residence, photo,
            father_id, mother_id, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (genealogy_id, "pending", payload["name"], payload["gender"], payload["birth_year"], payload["death_year"],
         payload["birthday"], payload["birthday_type"], payload["hometown"], payload["sibling_rank"],
         payload["zodiac"], payload["generation"], payload["contact"], payload["residence"], payload["photo"],
         payload["father_id"], payload["mother_id"], ts, ts),
    )
    mid = cur.lastrowid
    code = payload["code"] or f"M{mid:05d}"
    db.execute("UPDATE members SET code=? WHERE member_id=?", (code, mid))
    db.execute(
        """INSERT INTO relations (member_id, relation_type, father_id, mother_id, spouse_array)
           VALUES (?,?,?,?, '[]')""",
        (mid, payload["relation_type"], payload["father_id"], payload["mother_id"]),
    )
    sync_spouses(db, mid, payload["spouse_ids"])
    return mid


# --------------------------------------------------------------------------
# 生日历法换算
# --------------------------------------------------------------------------
@app.get("/api/calendar/convert")
@login_required
def api_calendar_convert():
    date_text = (request.args.get("date") or "").strip()
    cal_type = (request.args.get("type") or "solar").strip()
    if cal_type not in BIRTHDAY_TYPES:
        raise ApiError("历法只能是 solar（阳历）或 lunar（农历）")
    if not parse_date_text(date_text):
        raise ApiError("日期格式应为 YYYY-MM-DD")
    info = birthday_info(date_text, cal_type)
    return jsonify(ok=True, data=info)


# --------------------------------------------------------------------------
# 成员接口（按族谱）
# --------------------------------------------------------------------------
def branch_scope_ids(db, genealogy_id, anchor_id):
    """父亲名下整支：锚点本人、配偶、全部后代及其配偶。"""
    rows = db.execute(
        "SELECT member_id, father_id, mother_id FROM members WHERE genealogy_id=?",
        (genealogy_id,),
    ).fetchall()
    all_ids = {r["member_id"] for r in rows}
    if anchor_id not in all_ids:
        return set()
    children = {}
    for r in rows:
        for pid in (r["father_id"], r["mother_id"]):
            if pid in all_ids:
                children.setdefault(pid, set()).add(r["member_id"])

    scope = {anchor_id}
    queue = deque([anchor_id])
    while queue:
        mid = queue.popleft()
        for cid in children.get(mid, ()):
            if cid not in scope:
                scope.add(cid)
                queue.append(cid)

    # 分支内成员的配偶也属于该支，可维护其资料
    spouse_map = {}
    for rel in db.execute("SELECT member_id, spouse_array FROM relations").fetchall():
        if rel["member_id"] in all_ids:
            spouse_map[rel["member_id"]] = spouse_ids_of(rel)
    for mid in list(scope):
        for sid in spouse_map.get(mid, []):
            if sid in all_ids:
                scope.add(sid)
    return scope


def member_edit_scope(db, genealogy_id):
    """返回 (是否可改全部成员, 可修改成员 ID 集合)。

    admin：全部；branch_admin：父亲名下整支；normal：本人绑定身份；访客：无。
    """
    role = getattr(g, "role", None)
    if role == "admin":
        return True, None
    if role not in ("branch_admin", "normal"):
        return False, set()
    bound = db.execute(
        "SELECT member_id FROM genealogy_users WHERE genealogy_id=? AND user_id=?",
        (genealogy_id, g.user["id"]),
    ).fetchone()
    if not bound or not bound["member_id"]:
        return False, set()
    if role == "normal":
        return False, {bound["member_id"]}
    mem = db.execute(
        "SELECT father_id FROM members WHERE member_id=? AND genealogy_id=?",
        (bound["member_id"], genealogy_id),
    ).fetchone()
    if not mem:
        return False, set()
    anchor = mem["father_id"] if mem["father_id"] else bound["member_id"]
    return False, branch_scope_ids(db, genealogy_id, anchor)


def can_edit_member(db, genealogy_id, member_id):
    edit_all, allowed = member_edit_scope(db, genealogy_id)
    return edit_all or member_id in allowed


@app.get("/api/genealogies/<int:genealogy_id>/members")
@login_required
@require_genealogy_read
def api_members(genealogy_id):
    db = get_db()
    rows = db.execute(
        """SELECT m.*, r.relation_id, r.relation_type, r.spouse_array
           FROM members m LEFT JOIN relations r ON r.member_id = m.member_id
           WHERE m.genealogy_id = ?
           ORDER BY m.generation, m.birth_year IS NULL, m.birth_year,
                    m.sibling_rank IS NULL, m.sibling_rank, m.member_id""",
        (genealogy_id,),
    ).fetchall()
    data = []
    edit_all, edit_ids = member_edit_scope(db, genealogy_id)
    for row in rows:
        item = row_to_dict(row)
        item.update(birthday_info(item.get("birthday"), item.get("birthday_type")))
        item["spouse_ids"] = spouse_ids_of(row)
        item["children_count"] = db.execute(
            "SELECT COUNT(*) FROM members WHERE father_id=? OR mother_id=?", (row["member_id"], row["member_id"])
        ).fetchone()[0]
        item["can_edit"] = edit_all or row["member_id"] in edit_ids
        if g.public_only:
            mask_private_fields(item)
        data.append(item)
    return jsonify(ok=True, data=data)


@app.get("/api/genealogies/<int:genealogy_id>/members/<int:member_id>")
@login_required
@require_genealogy_read
def api_member_detail(genealogy_id, member_id):
    db = get_db()
    row = db.execute("SELECT genealogy_id FROM members WHERE member_id=?", (member_id,)).fetchone()
    if not row or row["genealogy_id"] != genealogy_id:
        raise ApiError("成员不存在或不在当前族谱", 404)
    data = full_member(db, member_id)
    data["can_edit"] = can_edit_member(db, genealogy_id, member_id)
    if g.public_only:
        mask_private_fields(data)
        for spouse in data.get("spouses") or []:
            mask_private_fields(spouse)
    return jsonify(ok=True, data=data)


@app.post("/api/genealogies/<int:genealogy_id>/members")
@login_required
@require_genealogy_role("normal")
def api_member_create(genealogy_id):
    db = get_db()
    payload = validate_member(request.get_json(silent=True) or {}, db, genealogy_id)
    if g.role == "admin":
        mid = insert_member(db, genealogy_id, payload)
        refresh_sibling_ranks(db, genealogy_id)
        db.commit()
        return jsonify(ok=True, data=full_member(db, mid), via="direct"), 201
    # branch_admin：进入审批队列
    db.execute(
        """INSERT INTO proposals (genealogy_id, proposer_id, action, payload)
           VALUES (?,?, 'add_member', ?)""",
        (genealogy_id, g.user["id"], json.dumps(payload, ensure_ascii=False)),
    )
    db.commit()
    return jsonify(ok=True, data={"submitted": True, "message": "已提交管理员审批"}), 202


@app.put("/api/genealogies/<int:genealogy_id>/members/<int:member_id>")
@login_required
@require_genealogy_read
def api_member_update(genealogy_id, member_id):
    db = get_db()
    existing = db.execute("SELECT * FROM members WHERE member_id=?", (member_id,)).fetchone()
    if not existing or existing["genealogy_id"] != genealogy_id:
        raise ApiError("成员不存在或不在当前族谱", 404)
    if not can_edit_member(db, genealogy_id, member_id):
        if g.role == "normal":
            raise ApiError("普通成员只能修改自己绑定的身份信息", 403)
        raise ApiError("该成员不在你可管理的父系分支内", 403)
    body = request.get_json(silent=True) or {}
    if g.role == "normal":
        # 个人资料以外的结构字段一律忽略，保持原值
        body = {k: v for k, v in body.items() if k in PERSONAL_MEMBER_FIELDS}
    merged = {**row_to_dict(existing), **body}
    if "spouse_ids" not in body:
        merged["spouse_ids"] = spouse_ids_of(ensure_relation(db, member_id))
    payload = validate_member(merged, db, genealogy_id, member_id=member_id,
                              current_generation=existing["generation"])
    ts = now_str()
    db.execute(
        """UPDATE members SET name=?, gender=?, birth_year=?, death_year=?,
           birthday=?, birthday_type=?, hometown=?,
           sibling_rank=?, zodiac=?, generation=?, contact=?, residence=?, photo=?, father_id=?,
           mother_id=?, updated_at=? WHERE member_id=?""",
        (payload["name"], payload["gender"], payload["birth_year"], payload["death_year"],
         payload["birthday"], payload["birthday_type"], payload["hometown"],
         payload["sibling_rank"], payload["zodiac"], payload["generation"],
         payload["contact"], payload["residence"], payload["photo"], payload["father_id"],
         payload["mother_id"], ts, member_id),
    )
    if payload["code"]:
        db.execute("UPDATE members SET code=? WHERE member_id=?", (payload["code"], member_id))
    ensure_relation(db, member_id)
    db.execute(
        "UPDATE relations SET relation_type=?, father_id=?, mother_id=? WHERE member_id=?",
        (payload["relation_type"], payload["father_id"], payload["mother_id"], member_id),
    )
    sync_spouses(db, member_id, payload["spouse_ids"])
    cascade_descendant_generations(db, genealogy_id, member_id)
    refresh_sibling_ranks(db, genealogy_id)
    db.commit()
    data = full_member(db, member_id)
    data["can_edit"] = True
    return jsonify(ok=True, data=data)


@app.delete("/api/genealogies/<int:genealogy_id>/members/<int:member_id>")
@login_required
@require_genealogy_role("admin")
def api_member_delete(genealogy_id, member_id):
    db = get_db()
    row = db.execute("SELECT * FROM members WHERE member_id=?", (member_id,)).fetchone()
    if not row or row["genealogy_id"] != genealogy_id:
        raise ApiError("成员不存在或不在当前族谱", 404)
    bound = db.execute(
        """SELECT u.username FROM genealogy_users gu JOIN users u ON u.id = gu.user_id
           WHERE gu.member_id=?""",
        (member_id,),
    ).fetchone()
    if bound:
        raise ApiError(f"该成员已绑定账号 {bound['username']}，请先解除绑定", 400)
    refs = db.execute(
        "SELECT COUNT(*) FROM members WHERE father_id=? OR mother_id=?", (member_id, member_id)
    ).fetchone()[0]
    if refs:
        raise ApiError(f"该成员仍被 {refs} 位子女引用为父/母节点，请先调整子女关系")
    for sid in spouse_ids_of(ensure_relation(db, member_id)):
        remove_spouse_link(db, member_id, sid)
    photo = row["photo"] or ""
    db.execute("DELETE FROM members WHERE member_id=?", (member_id,))
    refresh_sibling_ranks(db, genealogy_id)
    db.commit()
    if photo.startswith("/static/uploads/"):
        path = os.path.join(BASE_DIR, photo.lstrip("/").replace("/", os.sep))
        if os.path.isfile(path):
            try:
                os.remove(path)
            except OSError:
                pass
    return jsonify(ok=True, data={"deleted": member_id})


# --------------------------------------------------------------------------
# 审批队列
# --------------------------------------------------------------------------
@app.post("/api/genealogies/<int:genealogy_id>/join")
@login_required
def api_genealogy_join(genealogy_id):
    """申请加入公开族谱并绑定到谱成员，管理员审批后生效。"""
    data = request.get_json(silent=True) or {}
    member_id = parse_int(data.get("member_id"), "绑定成员", allow_none=False)
    db = get_db()
    gen = db.execute("SELECT * FROM genealogies WHERE id=?", (genealogy_id,)).fetchone()
    if not gen:
        raise ApiError("族谱不存在", 404)
    if gen["kind"] == "kinship":
        raise ApiError("亲戚谱不支持申请加入", 403)
    if gen["visibility"] != "public":
        raise ApiError("该族谱为私密谱，请联系管理员邀请加入", 403)
    if db.execute("SELECT 1 FROM genealogy_users WHERE genealogy_id=? AND user_id=?",
                  (genealogy_id, g.user["id"])).fetchone():
        raise ApiError("你已是该族谱成员", 400)
    member = db.execute("SELECT member_id, name FROM members WHERE member_id=? AND genealogy_id=?",
                        (member_id, genealogy_id)).fetchone()
    if not member:
        raise ApiError("绑定的成员不在该族谱中", 400)
    if db.execute("SELECT 1 FROM genealogy_users WHERE genealogy_id=? AND member_id=?",
                  (genealogy_id, member_id)).fetchone():
        raise ApiError("该成员已绑定其他账号，请选择其他成员或联系管理员", 409)
    if db.execute("""SELECT 1 FROM proposals WHERE genealogy_id=? AND proposer_id=?
                     AND action='join_bind' AND status='pending'""",
                  (genealogy_id, g.user["id"])).fetchone():
        raise ApiError("你在该族谱已有待审批的加入申请", 400)
    for row in db.execute("""SELECT payload FROM proposals WHERE genealogy_id=?
                             AND action='join_bind' AND status='pending'""", (genealogy_id,)):
        try:
            if json.loads(row["payload"]).get("member_id") == member_id:
                raise ApiError("该成员已有待审批的绑定申请，请联系管理员处理", 409)
        except (TypeError, ValueError):
            continue
    cur = db.execute(
        "INSERT INTO proposals (genealogy_id, proposer_id, action, payload) VALUES (?,?, 'join_bind', ?)",
        (genealogy_id, g.user["id"], json.dumps({"member_id": member_id}, ensure_ascii=False)),
    )
    db.commit()
    return jsonify(ok=True, data={"proposal_id": cur.lastrowid, "status": "pending",
                                  "member_id": member_id, "member_name": member["name"]}), 202


@app.get("/api/genealogies/<int:genealogy_id>/proposals")
@login_required
@require_genealogy_read
def api_proposals(genealogy_id):
    db = get_db()
    if g.public_only:
        return jsonify(ok=True, data=[])
    if g.role == "admin":
        rows = db.execute(
            """SELECT p.*, u.username AS proposer_name, u.display_name AS proposer_display
               FROM proposals p JOIN users u ON u.id = p.proposer_id
               WHERE p.genealogy_id=?
               ORDER BY p.created_at DESC""",
            (genealogy_id,),
        ).fetchall()
    else:
        rows = db.execute(
            """SELECT p.*, u.username AS proposer_name, u.display_name AS proposer_display
               FROM proposals p JOIN users u ON u.id = p.proposer_id
               WHERE p.genealogy_id=? AND p.proposer_id=?
               ORDER BY p.created_at DESC""",
            (genealogy_id, g.user["id"]),
        ).fetchall()
    data = []
    for r in rows:
        d = row_to_dict(r)
        try:
            d["payload"] = json.loads(d["payload"])
        except (TypeError, ValueError):
            pass
        if d.get("action") == "join_bind" and isinstance(d.get("payload"), dict):
            mid = d["payload"].get("member_id")
            mrow = db.execute("SELECT name FROM members WHERE member_id=?", (mid,)).fetchone() if mid else None
            d["target_member_name"] = mrow["name"] if mrow else None
        data.append(d)
    return jsonify(ok=True, data=data)


@app.post("/api/genealogies/<int:genealogy_id>/proposals/<int:proposal_id>/approve")
@login_required
@require_genealogy_role("admin")
def api_proposal_approve(genealogy_id, proposal_id):
    db = get_db()
    prop = db.execute(
        "SELECT * FROM proposals WHERE id=? AND genealogy_id=?", (proposal_id, genealogy_id)
    ).fetchone()
    if not prop:
        raise ApiError("审批单不存在", 404)
    if prop["status"] != "pending":
        raise ApiError("该审批单已处理")
    payload = json.loads(prop["payload"])
    if prop["action"] == "add_member":
        result = {"member_id": insert_member(db, genealogy_id, payload)}
        refresh_sibling_ranks(db, genealogy_id)
    elif prop["action"] == "join_bind":
        # 加入 + 绑定：复查资格与占用后写入 normal 成员身份和绑定关系
        member_id = parse_int(payload.get("member_id"), "绑定成员", allow_none=False)
        member = db.execute("SELECT member_id FROM members WHERE member_id=? AND genealogy_id=?",
                            (member_id, genealogy_id)).fetchone()
        if not member:
            raise ApiError("目标成员已不在该族谱中，请驳回该申请", 400)
        if db.execute("SELECT 1 FROM genealogy_users WHERE genealogy_id=? AND user_id=?",
                      (genealogy_id, prop["proposer_id"])).fetchone():
            raise ApiError("申请人已是该族谱成员", 400)
        if db.execute("SELECT 1 FROM genealogy_users WHERE genealogy_id=? AND member_id=?",
                      (genealogy_id, member_id)).fetchone():
            raise ApiError("该成员已绑定其他账号", 409)
        try:
            db.execute(
                "INSERT INTO genealogy_users (genealogy_id, user_id, role, member_id) VALUES (?,?, 'normal', ?)",
                (genealogy_id, prop["proposer_id"], member_id),
            )
        except sqlite3.IntegrityError:
            db.rollback()  # 唯一索引兜底：保留待审记录，由管理员处理冲突
            raise ApiError("绑定冲突：该成员已被其他账号绑定", 409)
        result = {"user_id": prop["proposer_id"], "member_id": member_id}
    else:
        raise ApiError(f"未知的审批类型：{prop['action']}", 400)
    db.execute(
        "UPDATE proposals SET status='approved', reviewed_by=?, reviewed_at=? WHERE id=?",
        (g.user["id"], now_str(), proposal_id),
    )
    db.commit()
    if prop["action"] == "join_bind":
        ensure_kinship(db, prop["proposer_id"])
    return jsonify(ok=True, data=result)


@app.post("/api/genealogies/<int:genealogy_id>/proposals/<int:proposal_id>/reject")
@login_required
@require_genealogy_role("admin")
def api_proposal_reject(genealogy_id, proposal_id):
    data = request.get_json(silent=True) or {}
    reason = (data.get("reason") or "").strip()[:200]
    db = get_db()
    prop = db.execute("SELECT * FROM proposals WHERE id=? AND genealogy_id=?",
                      (proposal_id, genealogy_id)).fetchone()
    if not prop:
        raise ApiError("审批单不存在", 404)
    if prop["status"] != "pending":
        raise ApiError("该审批单已处理")
    db.execute(
        "UPDATE proposals SET status='rejected', reviewed_by=?, reviewed_at=?, reject_reason=? WHERE id=?",
        (g.user["id"], now_str(), reason, proposal_id),
    )
    db.commit()
    return jsonify(ok=True)


# --------------------------------------------------------------------------
# 关系表 & 统计
# --------------------------------------------------------------------------
@app.get("/api/genealogies/<int:genealogy_id>/relations")
@login_required
@require_genealogy_read
def api_relations(genealogy_id):
    db = get_db()
    rows = db.execute(
        """SELECT r.relation_id, r.member_id, r.relation_type, r.father_id, r.mother_id, r.spouse_array,
                  m.code, m.name, m.generation, m.sibling_rank,
                  f.name AS father_name, mo.name AS mother_name
           FROM relations r
           JOIN members m ON m.member_id = r.member_id
           LEFT JOIN members f ON f.member_id = r.father_id
           LEFT JOIN members mo ON mo.member_id = r.mother_id
           WHERE m.genealogy_id = ?
           ORDER BY r.relation_id""",
        (genealogy_id,),
    ).fetchall()
    data = []
    edit_all, edit_ids = member_edit_scope(db, genealogy_id)
    for row in rows:
        item = row_to_dict(row)
        item["spouses"] = [brief(db, sid) for sid in spouse_ids_of(row) if brief(db, sid)]
        item["can_edit"] = edit_all or row["member_id"] in edit_ids
        data.append(item)
    return jsonify(ok=True, data=data)


@app.get("/api/genealogies/<int:genealogy_id>/stats")
@login_required
@require_genealogy_read
def api_stats(genealogy_id):
    db = get_db()
    total = db.execute("SELECT COUNT(*) FROM members WHERE genealogy_id=?", (genealogy_id,)).fetchone()[0]
    male = db.execute("SELECT COUNT(*) FROM members WHERE genealogy_id=? AND gender='男'", (genealogy_id,)).fetchone()[0]
    female = total - male
    max_gen = db.execute("SELECT COALESCE(MAX(generation),0) FROM members WHERE genealogy_id=?", (genealogy_id,)).fetchone()[0]
    return jsonify(ok=True, data={
        "members": total, "male": male, "female": female,
        "max_generation": max_gen, "max_generations": MAX_GENERATIONS,
        "max_kinship_levels": MAX_KINSHIP_LEVELS,
        "role": g.role,
    })


# --------------------------------------------------------------------------
# 家谱 / 亲戚谱（家谱按族谱；亲戚谱可跨族谱）
# --------------------------------------------------------------------------
def load_dataset(db, genealogy_id=None):
    members = {}
    if genealogy_id is not None:
        rows = db.execute("SELECT * FROM members WHERE genealogy_id=?", (genealogy_id,)).fetchall()
    else:
        rows = db.execute("SELECT * FROM members").fetchall()
    for row in rows:
        members[row["member_id"]] = row_to_dict(row)
    rels = {}
    for row in db.execute("SELECT * FROM relations").fetchall():
        rels[row["member_id"]] = row_to_dict(row)
    return members, rels


def spouse_summaries(member_id, rels, members):
    out = []
    for sid in spouse_ids_of(rels.get(member_id)):
        m = members.get(sid)
        if m:
            out.append({"id": sid, "name": m["name"], "gender": m["gender"],
                        "code": m["code"], "generation": m["generation"],
                        "birth_year": m["birth_year"], "death_year": m["death_year"],
                        "zodiac": m["zodiac"], "photo": m["photo"]})
    return out


def node_payload(member_id, members, rels, depth=0):
    m = members[member_id]
    rel = rels.get(member_id) or {}
    rel_type = rel.get("relation_type")
    if not rel_type:
        rel_type = "血缘" if (m["father_id"] or m["mother_id"]) else "配偶"
    binfo = birthday_info(m["birthday"], m["birthday_type"])
    return {
        "id": member_id, "code": m["code"], "name": m["name"], "gender": m["gender"],
        "generation": m["generation"], "sibling_rank": m["sibling_rank"],
        "birth_year": m["birth_year"], "death_year": m["death_year"],
        "birthday": m["birthday"], "birthday_type": m["birthday_type"],
        "birthday_solar": binfo["birthday_solar"], "birthday_lunar": binfo["birthday_lunar"],
        "birthday_text": binfo["birthday_text"],
        "hometown": m["hometown"], "residence": m["residence"], "contact": m["contact"],
        "zodiac": m["zodiac"], "photo": m["photo"], "father_id": m["father_id"], "mother_id": m["mother_id"],
        "relation_id": rel.get("relation_id"), "relation_type": rel_type,
        "spouses": spouse_summaries(member_id, rels, members), "children": [], "depth": depth,
    }


def sibling_sort_key(members, member_id):
    m = members[member_id]
    # 兄弟姐妹严格按出生年排序：有出生年的在前（升序），未注明的排后
    return (m["birth_year"] is None, m["birth_year"] or 0,
            m["sibling_rank"] is None, m["sibling_rank"] or 0, member_id)


def public_node_payload(member_id, members, rels, depth=0):
    """公开谱脱敏节点：仅姓名/性别/代际/生卒年/关系，不含联系方式、住址、照片、生日等隐私字段。"""
    m = members[member_id]
    rel = rels.get(member_id) or {}
    rel_type = rel.get("relation_type")
    if not rel_type:
        rel_type = "血缘" if (m["father_id"] or m["mother_id"]) else "配偶"
    spouses = []
    for sid in spouse_ids_of(rels.get(member_id)):
        s = members.get(sid)
        if s:
            spouses.append({"id": sid, "name": s["name"], "gender": s["gender"],
                            "generation": s["generation"],
                            "birth_year": s["birth_year"], "death_year": s["death_year"]})
    return {
        "id": member_id, "name": m["name"], "gender": m["gender"],
        "generation": m["generation"], "sibling_rank": m["sibling_rank"],
        "birth_year": m["birth_year"], "death_year": m["death_year"],
        "father_id": m["father_id"], "mother_id": m["mother_id"],
        "relation_type": rel_type,
        "spouses": spouses, "children": [], "depth": depth,
    }


def mask_private_fields(item):
    """访客查看时隐藏联系方式、住址、生日等隐私字段。"""
    for key in ("contact", "residence", "hometown", "birthday", "birthday_type",
                "birthday_solar", "birthday_lunar", "birthday_text", "zodiac", "photo"):
        if key in item:
            item[key] = None
    return item


def iter_nodes(node):
    yield node
    for child in node["children"]:
        yield from iter_nodes(child)


def paternal_line_root(members, start_id):
    """沿父亲向上找到最上代祖先，并返回上移的代数。"""
    root = start_id
    steps = 0
    seen = set()
    while root in members and root not in seen:
        seen.add(root)
        father = members[root]["father_id"]
        if not father or father not in members:
            break
        root = father
        steps += 1
    return root, steps


def kinship_branch_root(members, rels, center_id, branch):
    """亲戚谱分支根节点：父系=父系最上祖先；母系=母亲之父及更上代；
    配偶父系=配偶之父及更上代；配偶母系=配偶之母之父及更上代。

    返回 (根节点 ID, 向上扩展的代数)。向上扩展后需放宽层级限制，
    避免新增祖先后把原有后代挤出视图。
    """
    center = members.get(center_id)
    if not center:
        return None, 0
    if branch == "father":
        father = center["father_id"]
        start = father if father in members else center_id
        # 与母系、配偶分支一致：以最上祖先为根，并把上移代数计入层级上限
        return paternal_line_root(members, start)
    if branch == "mother":
        mother = center["mother_id"]
        if not mother or mother not in members:
            return None, 0
        father = members[mother]["father_id"]
        start = father if father in members else mother
        return paternal_line_root(members, start)
    if branch in ("spouse", "spouse_father", "spouse_mother"):
        spouse = next((sid for sid in spouse_ids_of(rels.get(center_id)) if sid in members), None)
        if not spouse:
            return None, 0
        if branch == "spouse_mother":
            # 配偶母系：从配偶的母亲出发，优先上移到外祖父的父系最上祖先
            mother = members[spouse]["mother_id"]
            if not mother or mother not in members:
                return None, 0
            father = members[mother]["father_id"]
            start = father if father in members else mother
            return paternal_line_root(members, start)
        # 配偶父系（旧 branch=spouse 为其别名）
        father = members[spouse]["father_id"]
        start = father if father in members else spouse
        return paternal_line_root(members, start)
    return None, 0


@app.get("/api/genealogies/<int:genealogy_id>/tree/lineage")
@login_required
@require_genealogy_read
def api_lineage(genealogy_id):
    db = get_db()
    members, rels = load_dataset(db, genealogy_id)
    if not members:
        return jsonify(ok=True, data=None)
    max_gen = request.args.get("max_generations", default=MAX_GENERATIONS, type=int) or MAX_GENERATIONS
    max_gen = max(1, min(max_gen, MAX_GENERATIONS))
    branch = (request.args.get("branch") or "").strip()
    max_depth = None
    center_id = None
    if branch in ("father", "mother", "spouse", "spouse_father", "spouse_mother"):
        gen = db.execute(
            "SELECT kind, source_member_id FROM genealogies WHERE id=?", (genealogy_id,)
        ).fetchone()
        if not gen:
            raise ApiError("族谱不存在", 404)
        if gen["kind"] == "kinship":
            center = db.execute(
                "SELECT member_id FROM members WHERE genealogy_id=? AND source_member_id=?",
                (genealogy_id, gen["source_member_id"]),
            ).fetchone()
            if not center:
                raise ApiError("亲戚谱中心成员缺失，请重新同步亲戚谱", 400)
            center_id = center["member_id"]
        else:
            # 普通家谱的亲戚谱视图：以用户选择的中心成员计算三支
            center_id = request.args.get("center_id", type=int)
            if center_id not in members:
                raise ApiError("请指定有效的中心成员", 400)
        levels = request.args.get("levels", type=int) or (7 if branch == "father" else 5)
        root_id, steps_up = kinship_branch_root(members, rels, center_id, branch)
        # 新增祖先后根节点会上移，放宽层级以免原有后代被挤出视图
        max_depth = max(1, min(levels + steps_up, MAX_GENERATIONS))
        if not root_id:
            return jsonify(ok=True, data={
                "mode": "branch", "branch": branch, "root": None, "root_id": None,
                "center_id": center_id, "levels": max_depth, "generations": 0,
                "total": 0, "depth": 0, "spouse_count": 0,
            })
    else:
        branch = ""
        root_id = request.args.get("root_id", type=int)
        if root_id not in members:
            candidates = []
            for mid, m in members.items():
                if m["father_id"] or m["mother_id"]:
                    continue
                if (rels.get(mid) or {}).get("relation_type") == "配偶":
                    continue
                candidates.append(mid)
            if not candidates:
                candidates = [min(members, key=lambda i: members[i]["generation"])]
            candidates.sort(key=lambda i: (members[i]["generation"], members[i]["birth_year"] or 9999, i))
            root_id = candidates[0]
    child_map = {}
    for mid, m in members.items():
        for parent in (m["father_id"], m["mother_id"]):
            if parent:
                child_map.setdefault(parent, [])
                if mid not in child_map[parent]:
                    child_map[parent].append(mid)
    # 当前人与配偶的子女在三个分支中都要显示；数据常只登记父母一方
    partner_ids = set(spouse_ids_of(rels.get(center_id)))
    couple_children = set(child_map.get(center_id, []))
    for sid in partner_ids:
        if sid in members:
            couple_children |= set(child_map.get(sid, []))
    target_id = center_id
    if branch in ("spouse", "spouse_father", "spouse_mother"):
        target_id = next((sid for sid in partner_ids if sid in members), None)
    if target_id in members:
        bucket = child_map.setdefault(target_id, [])
        for cid in couple_children:
            if cid != target_id and cid not in partner_ids and cid not in bucket:
                bucket.append(cid)

    def build(mid, depth, seen):
        if getattr(g, "public_only", False):
            node = public_node_payload(mid, members, rels, depth)
        else:
            node = node_payload(mid, members, rels, depth)
        within_depth = max_depth is None or depth + 1 < max_depth
        if depth + 1 < max_gen and within_depth:
            for cid in sorted(child_map.get(mid, []), key=lambda i: sibling_sort_key(members, i)):
                if cid in seen:
                    continue
                node["children"].append(build(cid, depth + 1, seen | {cid}))
        return node

    root = build(root_id, 0, {root_id})
    nodes = list(iter_nodes(root))
    depth = max([n["depth"] for n in nodes] + [0])
    return jsonify(ok=True, data={
        "mode": "branch" if branch else "lineage", "branch": branch or None,
        "root": root, "root_id": root_id, "center_id": center_id, "levels": max_depth,
        "generations": depth + 1 if nodes else 0,
        "max_generations": max_gen, "generation_limit": MAX_GENERATIONS,
        "total": len(nodes),
        "depth": depth,
        "spouse_count": len({s["id"] for n in nodes for s in n["spouses"]}),
    })


# --------------------------------------------------------------------------
# 亲戚谱：绑定成员后自动建谱、按亲属广度 7 层复制节点、增量同步
# --------------------------------------------------------------------------
KINSHIP_MAX_LEVELS = 7  # 本人计为第 1 级，最多 7 级（本人 + 6 跳亲属）
KINSHIP_MAX_HOPS = KINSHIP_MAX_LEVELS - 1
KINSHIP_MAX_NODES = 500


def kinship_binding(db, user_id):
    """用户绑定的家谱身份：取最早绑定的普通家谱成员。"""
    return db.execute(
        """SELECT gu.genealogy_id, gu.member_id
           FROM genealogy_users gu JOIN genealogies gg ON gg.id = gu.genealogy_id
           WHERE gu.user_id=? AND gu.member_id IS NOT NULL AND gg.kind='family'
           ORDER BY gu.genealogy_id LIMIT 1""",
        (user_id,),
    ).fetchone()


def kinship_bfs(members, rels, center_id, max_hops=KINSHIP_MAX_HOPS,
                max_nodes=KINSHIP_MAX_NODES):
    """亲属广度遍历：父/母、子女、配偶，最多 max_hops 跳（本人记 0 跳）。"""
    children = {}
    for mid, m in members.items():
        for pid in (m["father_id"], m["mother_id"]):
            if pid:
                children.setdefault(pid, set()).add(mid)
    dist = {center_id: 0}
    order = [center_id]
    queue = deque([center_id])
    while queue:
        cur = queue.popleft()
        depth = dist[cur]
        if depth >= max_hops:
            continue
        m = members.get(cur)
        if not m:
            continue
        neighbors = [m["father_id"], m["mother_id"]]
        neighbors.extend(children.get(cur, ()))
        neighbors.extend(spouse_ids_of(rels.get(cur)))
        for nb in neighbors:
            if nb in members and nb not in dist:
                if len(order) >= max_nodes:
                    return order, dist, True
                dist[nb] = depth + 1
                order.append(nb)
                queue.append(nb)
    return order, dist, False


def kinship_copy_photo(photo, genealogy_id, member_id):
    """复制照片文件，避免删除亲戚谱成员时误删源谱照片。"""
    if not photo or not photo.startswith("/static/uploads/"):
        return photo
    name = photo[len("/static/uploads/"):]
    src = os.path.join(UPLOAD_DIR, name.replace("/", os.sep))
    if not os.path.isfile(src):
        return photo
    new_name = f"k{genealogy_id}_{member_id}{os.path.splitext(name)[1]}"
    try:
        shutil.copy2(src, os.path.join(UPLOAD_DIR, new_name))
    except OSError:
        return photo
    return "/static/uploads/" + new_name


def ensure_kinship(db, user_id):
    """绑定家谱成员后自动创建/补齐亲戚谱；只增不删，保留手工添加。"""
    binding = kinship_binding(db, user_id)
    if not binding:
        return None
    src_gid = binding["genealogy_id"]
    center_id = binding["member_id"]
    members, rels = load_dataset(db, src_gid)
    if center_id not in members:
        return None
    center = members[center_id]
    description = "由已加入族谱中的本人身份自动生成，仅本人与源谱管理员可见"
    kin = db.execute(
        "SELECT * FROM genealogies WHERE kind='kinship' AND owner_user_id=? ORDER BY id LIMIT 1",
        (user_id,),
    ).fetchone()
    created = False
    if not kin:
        cur = db.execute(
            """INSERT INTO genealogies
               (name, description, creator_id, visibility, kind, owner_user_id,
                source_genealogy_id, source_member_id)
               VALUES (?,?,?, 'private', 'kinship', ?, ?, ?)""",
            (f"亲戚谱 · {center['name']}", description,
             user_id, user_id, src_gid, center_id),
        )
        kin_id = cur.lastrowid
        created = True
    else:
        kin_id = kin["id"]
    db.execute(
        """UPDATE genealogies
           SET name=?, description=?, source_genealogy_id=?, source_member_id=?, synced_at=?
           WHERE id=?""",
        (f"亲戚谱 · {center['name']}", description, src_gid, center_id, now_str(), kin_id),
    )
    db.execute(
        """INSERT INTO genealogy_users (genealogy_id, user_id, role) VALUES (?,?, 'admin')
           ON CONFLICT(genealogy_id, user_id) DO UPDATE SET role='admin'""",
        (kin_id, user_id),
    )

    selected, _dist, truncated = kinship_bfs(members, rels, center_id)
    selected_set = set(selected)

    # 清理超出 7 级范围的自动复制节点（手工添加的节点 source_member_id 为空，予以保留）
    stale_ids = [
        row["member_id"]
        for row in db.execute(
            """SELECT member_id, source_member_id FROM members
               WHERE genealogy_id=? AND source_member_id IS NOT NULL""",
            (kin_id,),
        )
        if row["source_member_id"] not in selected_set
    ]
    if stale_ids:
        bound_ids = {row["member_id"] for row in db.execute(
            "SELECT member_id FROM genealogy_users WHERE genealogy_id=? AND member_id IS NOT NULL",
            (kin_id,))}
        for mid in stale_ids:
            if mid in bound_ids:
                continue
            db.execute("UPDATE members SET father_id=NULL WHERE father_id=?", (mid,))
            db.execute("UPDATE members SET mother_id=NULL WHERE mother_id=?", (mid,))
            db.execute("UPDATE relations SET father_id=NULL WHERE father_id=?", (mid,))
            db.execute("UPDATE relations SET mother_id=NULL WHERE mother_id=?", (mid,))
            db.execute("DELETE FROM relations WHERE member_id=?", (mid,))
            db.execute("DELETE FROM members WHERE member_id=?", (mid,))

    # 统一平移基准：源谱全谱最小代际，避免每次同步因 BFS 选中集合变化产生不同偏移
    src_min_gen = db.execute(
        "SELECT COALESCE(MIN(generation), 1) FROM members WHERE genealogy_id=?",
        (src_gid,),
    ).fetchone()[0] or 1
    mapping = {
        row["source_member_id"]: row["member_id"]
        for row in db.execute(
            """SELECT member_id, source_member_id FROM members
               WHERE genealogy_id=? AND source_member_id IS NOT NULL""",
            (kin_id,),
        )
    }
    added = 0
    for src_id in selected:
        if src_id in mapping or len(mapping) >= KINSHIP_MAX_NODES:
            continue
        m = members[src_id]
        gen = m["generation"] - src_min_gen + 1
        if not 1 <= gen <= MAX_GENERATIONS:
            continue
        cur = db.execute(
            """INSERT INTO members
               (genealogy_id, code, name, gender, birth_year, death_year, birthday,
                birthday_type, hometown, sibling_rank, zodiac, generation, contact,
                residence, father_id, mother_id, source_member_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)""",
            (kin_id, f"K{kin_id}-{src_id}", m["name"], m["gender"], m["birth_year"],
             m["death_year"], m["birthday"], m["birthday_type"], m["hometown"],
             m["sibling_rank"], m["zodiac"], gen, m["contact"], m["residence"], src_id),
        )
        new_id = cur.lastrowid
        mapping[src_id] = new_id
        added += 1
        copied = kinship_copy_photo(m["photo"], kin_id, new_id)
        if copied != m["photo"]:
            db.execute("UPDATE members SET photo=? WHERE member_id=?", (copied, new_id))

    # 两阶段：成员全部就位后再写父/母/配偶，避免引用未复制节点
    # 亲戚谱内手工添加的成员（source_member_id 为空）及其手工关系不得被同步覆盖
    manual_ids = {row["member_id"] for row in db.execute(
        "SELECT member_id FROM members WHERE genealogy_id=? AND source_member_id IS NULL",
        (kin_id,),
    )}
    for src_id, new_id in mapping.items():
        if src_id not in members:
            continue
        m = members[src_id]
        father = mapping.get(m["father_id"]) if m["father_id"] else None
        mother = mapping.get(m["mother_id"]) if m["mother_id"] else None
        current = db.execute("SELECT father_id, mother_id FROM members WHERE member_id=?",
                             (new_id,)).fetchone()
        # 源谱没有对应父/母时，保留亲戚谱内手工建立的父/母关系
        if not father and current and current["father_id"] in manual_ids:
            father = current["father_id"]
        if not mother and current and current["mother_id"] in manual_ids:
            mother = current["mother_id"]
        db.execute("UPDATE members SET father_id=?, mother_id=? WHERE member_id=?",
                   (father, mother, new_id))
        rel = rels.get(src_id) or {}
        rel_type = rel.get("relation_type") or ("血缘" if (father or mother) else "配偶")
        ensure_relation(db, new_id)
        db.execute(
            "UPDATE relations SET relation_type=?, father_id=?, mother_id=? WHERE member_id=?",
            (rel_type, father, mother, new_id),
        )
        # 源谱配偶 + 亲戚谱内手工建立的配偶，两者合并写入，避免手工配偶被清空
        existing_rel = db.execute("SELECT spouse_array FROM relations WHERE member_id=?",
                                  (new_id,)).fetchone()
        manual_spouses = [sid for sid in spouse_ids_of(existing_rel) if sid in manual_ids]
        write_spouse_ids(db, new_id,
                         [mapping[s] for s in spouse_ids_of(rel) if s in mapping] + manual_spouses)

    refresh_sibling_ranks(db, kin_id)

    mine = mapping.get(center_id)
    if mine:
        db.execute(
            "UPDATE genealogy_users SET member_id=? WHERE genealogy_id=? AND user_id=?",
            (mine, kin_id, user_id),
        )

    # 源家谱管理员同步为本谱管理员，其余账号移除（仅保留本人与源谱管理员）
    admin_ids = {row["user_id"] for row in db.execute(
        "SELECT user_id FROM genealogy_users WHERE genealogy_id=? AND role='admin'", (src_gid,))}
    admin_ids.add(user_id)
    for uid in admin_ids:
        db.execute(
            """INSERT INTO genealogy_users (genealogy_id, user_id, role) VALUES (?,?, 'admin')
               ON CONFLICT(genealogy_id, user_id) DO UPDATE SET role='admin'""",
            (kin_id, uid),
        )
    placeholders = ",".join("?" * len(admin_ids))
    db.execute(
        f"DELETE FROM genealogy_users WHERE genealogy_id=? AND user_id NOT IN ({placeholders})",
        (kin_id, *admin_ids),
    )
    db.commit()
    return {"genealogy_id": kin_id, "created": created, "added": added,
            "total": len(mapping), "truncated": truncated}


@app.post("/api/kinship/sync")
@login_required
def api_kinship_sync():
    """兼容接口：前端不直接调用；登录、绑定与审批时已自动同步亲戚谱。"""
    result = ensure_kinship(get_db(), g.user["id"])
    if not result:
        raise ApiError("请先在家谱中绑定一项成员身份", 400)
    return jsonify(ok=True, data=result)


@app.get("/api/tree/kinship")
@login_required
def api_kinship():
    """兼容接口：小程序已改用 tree/lineage 三支视图，本接口仅保留给旧客户端。"""
    db = get_db()
    members, rels = load_dataset(db, genealogy_id=None)
    allowed = {row["genealogy_id"] for row in db.execute(
        "SELECT genealogy_id FROM genealogy_users WHERE user_id=?", (g.user["id"],))}
    allowed |= {row["id"] for row in db.execute(
        "SELECT id FROM genealogies WHERE visibility='public' AND kind='family'")}
    members = {mid: m for mid, m in members.items() if m["genealogy_id"] in allowed}
    rels = {mid: rel for mid, rel in rels.items() if mid in members}
    if not members:
        return jsonify(ok=True, data=None)
    focus_id = request.args.get("focus_id", type=int)
    if focus_id not in members:
        raise ApiError("请先选择一位中心成员", 400)
    side = (request.args.get("side") or "father").lower()
    if side not in ("father", "mother"):
        raise ApiError("展示方向只能是父系或母系")
    levels = request.args.get("levels", default=3, type=int)
    if levels is None:
        levels = 3
    if levels > MAX_KINSHIP_LEVELS:
        raise ApiError(f"亲戚谱仅支持 {MAX_KINSHIP_LEVELS} 级以内查询，本次请求 {levels} 级已超出，已被拒绝", 400)
    if levels < 1:
        raise ApiError(f"查询层级需在 1—{MAX_KINSHIP_LEVELS} 级之间", 400)
    focus = members[focus_id]
    center_id = focus["father_id"] if side == "father" else focus["mother_id"]
    side_label = "父亲" if side == "father" else "母亲"
    if not center_id or center_id not in members:
        raise ApiError(f"成员「{focus['name']}」没有{side_label}节点，无法生成{('父' if side == 'father' else '母')}系亲戚谱", 400)
    ancestors = []
    cur_id = center_id
    for _ in range(levels - 1):
        cur = members.get(cur_id)
        if not cur:
            break
        nxt = cur["father_id"] if side == "father" else cur["mother_id"]
        if not nxt or nxt not in members:
            break
        ancestors.append(node_payload(nxt, members, rels, 0))
        cur_id = nxt
    child_map = {}
    for mid, m in members.items():
        for parent in (m["father_id"], m["mother_id"]):
            if parent:
                child_map.setdefault(parent, [])
                if mid not in child_map[parent]:
                    child_map[parent].append(mid)

    def build(mid, depth, seen):
        node = node_payload(mid, members, rels, depth)
        if depth + 1 < levels:
            for cid in sorted(child_map.get(mid, []), key=lambda i: sibling_sort_key(members, i)):
                if cid in seen:
                    continue
                node["children"].append(build(cid, depth + 1, seen | {cid}))
        return node

    center = build(center_id, 0, {center_id})
    all_nodes = list(iter_nodes(center)) + ancestors
    return jsonify(ok=True, data={
        "mode": "kinship", "side": side,
        "side_label": "父系" if side == "father" else "母系",
        "levels": levels, "max_levels": MAX_KINSHIP_LEVELS,
        "focus_id": focus_id,
        "focus": {"id": focus_id, "name": focus["name"], "gender": focus["gender"],
                  "generation": focus["generation"], "birth_year": focus["birth_year"],
                  "death_year": focus["death_year"]},
        "center": center, "ancestors": ancestors,
        "total": len(all_nodes),
        "spouse_count": len({s["id"] for n in all_nodes for s in n["spouses"]}),
    })


# --------------------------------------------------------------------------
# 照片上传
# --------------------------------------------------------------------------
ALLOWED_EXT = {"png", "jpg", "jpeg", "webp", "gif"}


@app.post("/api/genealogies/<int:genealogy_id>/members/<int:member_id>/photo")
@login_required
@require_genealogy_read
def api_upload_photo(genealogy_id, member_id):
    db = get_db()
    row = db.execute("SELECT photo, genealogy_id FROM members WHERE member_id=?", (member_id,)).fetchone()
    if not row or row["genealogy_id"] != genealogy_id:
        raise ApiError("成员不存在或不在当前族谱", 404)
    if not can_edit_member(db, genealogy_id, member_id):
        raise ApiError("无权修改该成员的照片", 403)
    file = request.files.get("photo")
    if not file or not file.filename:
        raise ApiError("请选择要上传的照片文件")
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in ALLOWED_EXT:
        raise ApiError("照片格式仅支持 JPG / PNG / WEBP / GIF")
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    filename = f"member_{member_id}_{int(datetime.now().timestamp())}.{ext}"
    path = os.path.join(UPLOAD_DIR, filename)
    file.save(path)
    url = f"/static/uploads/{filename}"
    old = row["photo"] or ""
    db.execute("UPDATE members SET photo=?, updated_at=? WHERE member_id=?",
               (url, now_str(), member_id))
    db.commit()
    if old.startswith("/static/uploads/") and old != url:
        old_path = os.path.join(BASE_DIR, old.lstrip("/").replace("/", os.sep))
        if os.path.isfile(old_path):
            try:
                os.remove(old_path)
            except OSError:
                pass
    return jsonify(ok=True, data={"photo": url})


# --------------------------------------------------------------------------
# 导入 / 导出（Excel / JSON / CSV）
# --------------------------------------------------------------------------
MEMBER_COLUMNS = [
    ("code", "唯一编码"), ("name", "姓名"), ("gender", "性别"),
    ("birth_year", "出生年"), ("death_year", "去世年"),
    ("birthday", "生日"), ("birthday_type", "生日历法"), ("zodiac", "属相"),
    ("hometown", "籍贯"),
    ("sibling_rank", "兄弟排行"), ("generation", "代际"), ("contact", "联系方式"),
    ("residence", "居住地"), ("father_id", "父节点ID"), ("mother_id", "母节点ID"),
    ("relation_type", "关系类型"), ("spouse_ids", "配偶ID(逗号分隔)"),
]


def members_to_rows(genealogy_id):
    db = get_db()
    rows = db.execute(
        """SELECT m.*, r.relation_type, r.spouse_array
           FROM members m LEFT JOIN relations r ON r.member_id = m.member_id
           WHERE m.genealogy_id = ? ORDER BY m.member_id""",
        (genealogy_id,),
    ).fetchall()
    out = []
    for r in rows:
        d = row_to_dict(r)
        d["spouse_ids"] = ",".join(str(x) for x in spouse_ids_of(r))
        out.append(d)
    return out


@app.get("/api/genealogies/<int:genealogy_id>/export")
@login_required
@require_genealogy_role("normal")
def api_export(genealogy_id):
    fmt = (request.args.get("format") or "json").lower()
    rows = members_to_rows(genealogy_id)
    if fmt == "json":
        return jsonify(ok=True, data=rows)
    try:
        import pandas as pd
    except ImportError:
        raise ApiError("服务器缺少 pandas，无法导出表格", 500)
    if not rows:
        df = pd.DataFrame(columns=[zh for _, zh in MEMBER_COLUMNS])
    else:
        type_label = {"solar": "阳历", "lunar": "农历"}
        for r in rows:
            r["birthday_type"] = type_label.get(r.get("birthday_type") or "", "")
        df = pd.DataFrame([[r.get(k) for k, _ in MEMBER_COLUMNS] for r in rows],
                          columns=[zh for _, zh in MEMBER_COLUMNS])
    buf = io.BytesIO()
    if fmt in ("xlsx", "excel"):
        try:
            df.to_excel(buf, index=False, engine="openpyxl")
        except ImportError:
            raise ApiError("服务器缺少 openpyxl，无法导出 Excel", 500)
        buf.seek(0)
        return send_bytes(buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                          f"genealogy_{genealogy_id}.xlsx")
    elif fmt == "csv":
        df.to_csv(buf, index=False, encoding="utf-8-sig")
        buf.seek(0)
        return send_bytes(buf.getvalue(), "text/csv; charset=utf-8-sig", f"genealogy_{genealogy_id}.csv")
    raise ApiError("导出格式仅支持 json / xlsx / csv", 400)


def send_bytes(data, mimetype, filename):
    from flask import Response
    resp = Response(data, mimetype=mimetype)
    resp.headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    return resp


@app.post("/api/genealogies/<int:genealogy_id>/import")
@login_required
@require_genealogy_role("admin")
def api_import(genealogy_id):
    ensure_family_genealogy(get_db(), genealogy_id, "亲戚谱不支持批量导入")
    file = request.files.get("file")
    if not file or not file.filename:
        raise ApiError("请选择要导入的文件")
    ext = file.filename.rsplit(".", 1)[-1].lower()
    try:
        import pandas as pd
    except ImportError:
        raise ApiError("服务器缺少 pandas，无法导入", 500)
    if ext in ("xlsx", "xls"):
        df = pd.read_excel(file, engine="openpyxl" if ext == "xlsx" else None)
    elif ext == "csv":
        df = pd.read_csv(file)
    elif ext == "json":
        import io as _io
        df = pd.read_json(_io.BytesIO(file.read()))
    else:
        raise ApiError("仅支持 xlsx / csv / json 格式文件")
    zh_to_key = {zh: k for k, zh in MEMBER_COLUMNS}
    df = df.rename(columns=zh_to_key)
    db = get_db()
    imported = 0
    for _, row in df.iterrows():
        name = str(row.get("name") or "").strip()
        if not name or name == "nan":
            continue
        payload = {
            "name": name,
            "gender": str(row.get("gender") or "男").strip() or "男",
            "code": str(row.get("code") or "").strip() or None,
            "birth_year": row.get("birth_year"),
            "death_year": row.get("death_year"),
            "birthday": "" if pd.isna(row.get("birthday")) else str(row.get("birthday"))[:10],
            "birthday_type": {"农历": "lunar", "lunar": "lunar", "阳历": "solar",
                              "公历": "solar", "solar": "solar"}.get(
                                  str(row.get("birthday_type") or "").strip(), ""),
            "zodiac": "" if pd.isna(row.get("zodiac")) else row.get("zodiac"),
            "hometown": row.get("hometown"),
            "sibling_rank": row.get("sibling_rank"),
            "generation": row.get("generation") or 1,
            "contact": row.get("contact"),
            "residence": row.get("residence"),
            "father_id": row.get("father_id"),
            "mother_id": row.get("mother_id"),
            "relation_type": str(row.get("relation_type") or "血缘").strip() or "血缘",
            "spouse_ids": [int(x) for x in str(row.get("spouse_ids") or "").split(",") if x.strip().isdigit()],
        }
        try:
            validated = validate_member(payload, db, genealogy_id)
        except ApiError:
            continue
        insert_member(db, genealogy_id, validated)
        imported += 1
    refresh_sibling_ranks(db, genealogy_id)
    db.commit()
    return jsonify(ok=True, data={"imported": imported, "total": len(df)})


# --------------------------------------------------------------------------
# 启动
# --------------------------------------------------------------------------
# WSGI 部署（gunicorn 等）不会执行 __main__，导入时先确保表结构与目录存在
init_db()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    print(f"家和万事兴已启动： http://127.0.0.1:{port}")
    app.run(host="0.0.0.0", port=port, debug=False)
