#!/usr/bin/env python3
"""
facai-selfcheck
依据 pipeline.config.yaml 对「新代码」进行自动化自检

新代码定义：当前工作区中所有未合并到 origin/main 的代码
（含已提交未推送 + 已暂存 + 未暂存 + 未追踪的新文件）

用法:
  python selfcheck.py            # 全量（含编译检查）
  python selfcheck.py --fast     # 仅静态检查，跳过编译
  python selfcheck.py --all      # 强制全量检查（忽略增量）

依赖: PyYAML (pip install pyyaml)
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path
from dataclasses import dataclass
from typing import Optional

try:
    import yaml
except ImportError:
    print("错误: 需要 PyYAML，请运行 pip install pyyaml", file=sys.stderr)
    sys.exit(2)


# ════════════════════════════════════════════
# 全局状态
# ════════════════════════════════════════════

@dataclass
class Stats:
    """检测统计"""
    pass_count: int = 0
    warn_count: int = 0
    fail_count: int = 0

    def total(self) -> int:
        return self.pass_count + self.warn_count + self.fail_count


# ANSI 颜色（非 TTY 时禁用）
if sys.stdout.isatty():
    G = '\033[32m'   # green
    Y = '\033[33m'   # yellow
    R = '\033[31m'   # red
    B = '\033[1m'    # bold
    D = '\033[2m'    # dim
    N = '\033[0m'    # reset
else:
    G = Y = R = B = D = N = ''

stats = Stats()
CONFIG: dict = {}


# ════════════════════════════════════════════
# 输出工具
# ════════════════════════════════════════════

def header(text: str) -> None:
    print(f"\n{B}═══ {text} ═══{N}")

def section(text: str) -> None:
    print(f"\n{B}── {text} ──{N}")

def pass_msg(text: str) -> None:
    print(f"  {G}[PASS]{N} {text}")
    stats.pass_count += 1

def warn_msg(text: str) -> None:
    print(f"  {Y}[WARN]{N} {text}")
    stats.warn_count += 1

def fail_msg(text: str) -> None:
    print(f"  {R}[FAIL]{N} {text}")
    stats.fail_count += 1

def detail(text: str) -> None:
    print(f"        {D}{text}{N}")


# ════════════════════════════════════════════
# 配置加载
# ════════════════════════════════════════════

ROOT = Path(__file__).resolve().parents[4]  # .agents/skills/facai-selfcheck/scripts/ → 项目根
AGENTS_DIR = ROOT / '.agents'
CONFIG_PATH = AGENTS_DIR / 'pipeline.config.yaml'

def load_config() -> dict:
    """加载 pipeline.config.yaml"""
    if not CONFIG_PATH.exists():
        print(f"{R}错误: 配置文件不存在: {CONFIG_PATH}{N}", file=sys.stderr)
        print(f"请先运行 /facai-init 完成项目初始化。", file=sys.stderr)
        sys.exit(2)
    with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
        return yaml.safe_load(f) or {}


# ════════════════════════════════════════════
# Git 工具
# ════════════════════════════════════════════

REMOTE_BASE = 'origin/main'

def git(*args) -> str:
    """运行 git 命令，返回 stdout"""
    try:
        result = subprocess.run(
            ['git', '-C', str(ROOT)] + list(args),
            capture_output=True, text=True, timeout=30
        )
        return result.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return ''

def git_has_remote_base() -> bool:
    """检查 origin/main 是否存在"""
    return bool(git('rev-parse', '--verify', REMOTE_BASE))


def get_changed_files() -> list[Path]:
    """获取变更文件列表（增量模式）"""
    all_mode = ARGS.all
    source_root_str = CONFIG.get('project', {}).get('source_root', 'src')
    source_root = ROOT / source_root_str

    if all_mode:
        # 全量模式：扫描源码目录下所有文件
        if source_root.exists():
            return sorted(source_root.rglob('*'))
        return []

    if not git_has_remote_base():
        # origin/main 不存在，回退全量
        return get_changed_files_all(source_root)

    # 增量模式：git diff + ls-files --others
    changed = set()

    diff_output = git('diff', '--name-only', REMOTE_BASE)
    for line in diff_output.split('\n'):
        line = line.strip()
        if line:
            full = ROOT / line
            if full.exists() and full.is_file():
                changed.add(full)

    others_output = git('ls-files', '--others', '--exclude-standard')
    for line in others_output.split('\n'):
        line = line.strip()
        if line:
            full = ROOT / line
            if full.exists() and full.is_file():
                changed.add(full)

    return sorted(changed)


def get_changed_files_all(source_root: Path) -> list[Path]:
    """全量模式获取所有源码文件"""
    if source_root.exists():
        return sorted(f for f in source_root.rglob('*') if f.is_file())
    return []


# ════════════════════════════════════════════
# 文件过滤工具
# ════════════════════════════════════════════

def get_files_under(changed: list[Path], prefixes: list[str]) -> list[Path]:
    """从变更列表中按路径前缀过滤"""
    if ARGS.all:
        # 全量模式：遍历目录
        result = []
        for prefix in prefixes:
            full_prefix = ROOT / prefix
            if full_prefix.exists():
                result.extend(f for f in full_prefix.rglob('*') if f.is_file())
        return sorted(set(result))
    else:
        # 增量模式：从变更列表过滤
        result = []
        for f in changed:
            try:
                rel = f.relative_to(ROOT)
                rel_str = str(rel)
                for prefix in prefixes:
                    if rel_str.startswith(prefix):
                        result.append(f)
                        break
            except ValueError:
                continue
        return result


def check_pattern(
    level: str, desc: str, pattern: str,
    target_prefixes: list[str], changed: list[Path],
    exclude_prefixes: Optional[list[str]] = None,
    ignore_marker: Optional[str] = None,
) -> None:
    """
    核心检测函数：在目标文件中 grep 模式

    Args:
        level: FAIL | WARN | PASS
        desc: 检查描述
        pattern: 正则表达式
        target_prefixes: 目标路径前缀列表（相对于项目根）
        changed: 变更文件列表
        exclude_prefixes: 排除的路径前缀（如测试目录）
        ignore_marker: 文件级忽略标记（如 'selfcheck:ignore-unwrap'）
    """
    files = get_files_under(changed, target_prefixes)

    # 排除指定前缀
    if exclude_prefixes:
        files = [
            f for f in files
            if not any(
                str(f.relative_to(ROOT)).startswith(ep)
                for ep in exclude_prefixes
            )
        ]

    # 应用文件级忽略标记
    if ignore_marker:
        files = [f for f in files if not file_has_marker(f, ignore_marker)]

    if not files:
        pass_msg(f"{desc}（无新代码）")
        return

    hits = []
    regex = re.compile(pattern)
    for f in files:
        try:
            lines = f.read_text(encoding='utf-8', errors='ignore').split('\n')
            for i, line in enumerate(lines, 1):
                # 排除注释行（简单启发：行首空白后以 // 或 # 开头）
                stripped = line.lstrip()
                if stripped.startswith('//') or stripped.startswith('#'):
                    continue
                if regex.search(line):
                    rel = f.relative_to(ROOT)
                    hits.append(f"{rel}:{i}: {line.strip()}")
        except Exception:
            continue

    if not hits:
        pass_msg(desc)
    else:
        if level.upper() == 'FAIL':
            fail_msg(desc)
        elif level.upper() == 'WARN':
            warn_msg(desc)
        else:
            pass_msg(desc)
            return
        for h in hits:
            detail(h)


def file_has_marker(filepath: Path, marker: str) -> bool:
    """检查文件是否包含忽略标记"""
    try:
        content = filepath.read_text(encoding='utf-8', errors='ignore')
        return marker in content
    except Exception:
        return False


# ════════════════════════════════════════════
# 检测段
# ════════════════════════════════════════════

def check_dependency_direction(changed: list[Path]) -> None:
    """§依赖方向：从 architecture.dependencies 推导反向依赖"""
    section("§依赖方向")

    checks_cfg = CONFIG.get('checks', {}).get('dependency_direction', {})
    if not checks_cfg.get('enabled', True):
        pass_msg("依赖方向检查（已禁用）")
        return

    level = checks_cfg.get('level', 'FAIL')
    arch = CONFIG.get('architecture', {})
    modules = arch.get('modules', [])
    deps = arch.get('dependencies', [])
    source_root = CONFIG.get('project', {}).get('source_root', 'src')

    # 构建合法依赖集合
    legal_deps = set()
    for dep in deps:
        legal_deps.add((dep['from'], dep['to']))

    # 推导禁止的反向依赖：如果 A→B 合法但 B→A 不合法
    leaf_modules = arch.get('leaf_modules', [])
    import_syntax = CONFIG.get('rules', {}).get('import_syntax', '')

    has_any = False

    for module in modules:
        # 该模块不能依赖哪些模块（不在合法白名单中的）
        for other in modules:
            if module == other:
                continue
            if (module, other) not in legal_deps and (other, module) in legal_deps:
                # module → other 是反向依赖
                has_any = True
                # 生成检测 pattern
                # 根据 import_syntax 推测 import 模式
                target_prefix = f"{source_root}/{module}/"
                if import_syntax:
                    # 简单模式：检测 import_syntax + other
                    escaped_other = re.escape(other)
                    pattern = rf'(use\s+|import\s+.*from\s+|from\s+).*{escaped_other}'
                else:
                    pattern = rf'\b{re.escape(other)}\b'

                check_pattern(
                    level=level,
                    desc=f"{module} 反向依赖 {other}",
                    pattern=pattern,
                    target_prefixes=[target_prefix],
                    changed=changed,
                )

    # 叶子模块互斥检查
    if leaf_modules:
        for i, leaf_a in enumerate(leaf_modules):
            for leaf_b in leaf_modules[i+1:]:
                # leaf_a 不能引用 leaf_b，反之亦然
                for a, b in [(leaf_a, leaf_b), (leaf_b, leaf_a)]:
                    target_prefix = f"{source_root}/{a}/"
                    escaped_b = re.escape(b.split('/')[-1])
                    pattern = rf'(use\s+|import\s+.*from\s+|from\s+).*{escaped_b}'
                    check_pattern(
                        level=level,
                        desc=f"叶子模块 {a} 依赖 {b}",
                        pattern=pattern,
                        target_prefixes=[target_prefix],
                        changed=changed,
                    )

    if not has_any and not leaf_modules:
        pass_msg("依赖方向检查（架构未配置依赖关系，跳过）")


def check_import_style(changed: list[Path]) -> None:
    """§import 规范"""
    section("§import 规范")

    checks_cfg = CONFIG.get('checks', {}).get('import_style', {})
    if not checks_cfg.get('enabled', True):
        pass_msg("import 规范检查（已禁用）")
        return

    level = checks_cfg.get('level', 'WARN')
    forbidden = CONFIG.get('rules', {}).get('forbidden_relative', '')

    if not forbidden:
        pass_msg("import 规范检查（未配置 forbidden_relative，跳过）")
        return

    source_root = CONFIG.get('project', {}).get('source_root', 'src')
    check_pattern(
        level=level,
        desc=f"禁止的多级相对路径 ({forbidden})",
        pattern=re.escape(forbidden),
        target_prefixes=[f"{source_root}/"],
        changed=changed,
    )


def check_error_handling(changed: list[Path]) -> None:
    """§错误处理与日志"""
    section("§错误处理与日志")

    checks_cfg = CONFIG.get('checks', {}).get('error_handling', {})
    if not checks_cfg.get('enabled', True):
        pass_msg("错误处理检查（已禁用）")
        return

    level = checks_cfg.get('level', 'WARN')
    rules = CONFIG.get('rules', {})
    source_root = CONFIG.get('project', {}).get('source_root', 'src')
    test_dir = rules.get('test_dir', '')

    # forbidden_panics
    forbidden_panics = rules.get('forbidden_panics', [])
    if forbidden_panics:
        pattern = '|'.join(re.escape(p) for p in forbidden_panics)
        check_pattern(
            level=level,
            desc=f"禁止的 panic 类 API ({', '.join(forbidden_panics)})",
            pattern=pattern,
            target_prefixes=[f"{source_root}/"],
            changed=changed,
            exclude_prefixes=[test_dir] if test_dir else None,
            ignore_marker='selfcheck:ignore-unwrap',
        )
    else:
        pass_msg("panic 类 API 检查（未配置 forbidden_panics）")

    # forbidden_print
    forbidden_print = rules.get('forbidden_print', '')
    if forbidden_print:
        check_pattern(
            level=level,
            desc=f"禁止的打印语句 ({forbidden_print})",
            pattern=re.escape(forbidden_print),
            target_prefixes=[f"{source_root}/"],
            changed=changed,
            exclude_prefixes=[test_dir] if test_dir else None,
            ignore_marker='selfcheck:ignore-println',
        )
    else:
        pass_msg("打印语句检查（未配置 forbidden_print）")


def check_test_colocation(changed: list[Path]) -> None:
    """§测试代码归口：业务源码不得散落测试代码"""
    section("§测试代码规范")

    checks_cfg = CONFIG.get('checks', {}).get('test_colocation', {})
    if not checks_cfg.get('enabled', True):
        pass_msg("测试归口检查（已禁用）")
        return

    level = checks_cfg.get('level', 'FAIL')
    rules = CONFIG.get('rules', {})
    source_root = CONFIG.get('project', {}).get('source_root', 'src')
    test_dir = rules.get('test_dir', 'test')
    test_markers = rules.get('test_markers', [])

    if not test_markers:
        pass_msg("测试归口检查（未配置 test_markers，跳过）")
        return

    # 收集源码下除 test_dir 外的文件
    if ARGS.all:
        all_files = []
        src_path = ROOT / source_root
        if src_path.exists():
            for f in src_path.rglob('*'):
                if f.is_file():
                    rel = str(f.relative_to(ROOT))
                    if not rel.startswith(test_dir):
                        all_files.append(f)
    else:
        all_files = []
        for f in changed:
            try:
                rel = str(f.relative_to(ROOT))
                if rel.startswith(source_root) and not rel.startswith(test_dir):
                    all_files.append(f)
            except ValueError:
                continue

    if not all_files:
        pass_msg("业务源码无散落测试代码（无新代码）")
        return

    # 检测测试标识
    pattern = '|'.join(re.escape(m) for m in test_markers)
    regex = re.compile(pattern)
    hits = []
    for f in all_files:
        try:
            lines = f.read_text(encoding='utf-8', errors='ignore').split('\n')
            for i, line in enumerate(lines, 1):
                if regex.search(line):
                    rel = f.relative_to(ROOT)
                    hits.append(f"{rel}:{i}: {line.strip()}")
        except Exception:
            continue

    if not hits:
        pass_msg("业务源码（测试目录外）无散落测试代码")
    else:
        fail_msg(f"业务源码中发现测试代码，必须移入 {test_dir}（test-rule §1）")
        for h in hits:
            detail(h)


def check_test_coverage(changed: list[Path]) -> None:
    """§测试覆盖度：含可测逻辑的业务模块是否有测试覆盖"""
    section("§测试覆盖度")

    checks_cfg = CONFIG.get('checks', {}).get('test_coverage', {})
    if not checks_cfg.get('enabled', True):
        pass_msg("测试覆盖度检查（已禁用）")
        return

    level = checks_cfg.get('level', 'WARN')
    source_root = CONFIG.get('project', {}).get('source_root', 'src')
    test_dir = CONFIG.get('rules', {}).get('test_dir', 'test')

    # 收集全部测试文件（检查引用时需全量扫描）
    test_path = ROOT / test_dir
    all_test_files = []
    if test_path.exists():
        all_test_files = [f for f in test_path.rglob('*') if f.is_file()]

    # 收集待检查的业务源码（排除 test/ 和入口文件）
    entry_files = {'mod.rs', '__init__.py', 'index.ts', 'index.js', '__init__.ts'}
    coverage_src = []
    for f in changed:
        try:
            rel = str(f.relative_to(ROOT))
            if not rel.startswith(source_root):
                continue
            if rel.startswith(test_dir):
                continue
            if f.name in entry_files:
                continue
            coverage_src.append(f)
        except ValueError:
            continue

    if not coverage_src:
        pass_msg("测试覆盖度检查（无新代码）")
        return

    uncovered = 0
    module_reg = CONFIG.get('rules', {}).get('module_registration', 'pub mod')

    for src_file in coverage_src:
        try:
            content = src_file.read_text(encoding='utf-8', errors='ignore')
        except Exception:
            continue

        # 跳过标记了 ignore-coverage 的文件
        if 'selfcheck:ignore-coverage' in content:
            continue

        # 跳过不含可测逻辑的文件（无公开函数）
        # 简单启发：检测各语言的 pub fn / export function / def 等
        if not re.search(r'(pub\s+(async\s+)?fn|export\s+(async\s+)?function|export\s+def|def\s+\w+|func\s+\w+)', content):
            continue

        has_cov = False

        # 方式1：文件内含内联测试
        if '#[cfg(test)]' in content or '#[test]' in content or 'describe(' in content or 'def test_' in content:
            has_cov = True

        # 方式2：测试文件引用了该模块
        if not has_cov and all_test_files:
            try:
                rel = str(src_file.relative_to(ROOT / source_root))
                mod_path = rel.replace('/', '::').replace('\\', '::')
                # 去除文件扩展名
                mod_path = re.sub(r'\.\w+$', '', mod_path)
                mod_full = f"{source_root.replace('/', '::')}::{mod_path}"

                for tf in all_test_files:
                    try:
                        tf_content = tf.read_text(encoding='utf-8', errors='ignore')
                        if mod_full in tf_content or mod_path.replace('/', '.') in tf_content:
                            has_cov = True
                            break
                    except Exception:
                        continue
            except ValueError:
                pass

        if not has_cov:
            rel_show = str(src_file.relative_to(ROOT))
            warn_msg(f"{src_file.name} 含可测逻辑但缺少测试覆盖")
            detail(rel_show)
            detail(f"建议：在 {test_dir} 下新增对应测试，或在该文件末尾内联测试")
            uncovered += 1

    if uncovered == 0:
        pass_msg("待检业务模块均有测试覆盖")


def check_domain_rules(changed: list[Path]) -> None:
    """§领域规则：从 domain_checks 检测"""
    section("§领域规则")

    domain_checks = CONFIG.get('domain_checks', [])
    if not domain_checks:
        pass_msg("领域规则检查（无配置）")
        return

    for dc in domain_checks:
        desc = dc.get('desc', '领域规则')
        pattern = dc.get('pattern', '')
        target = dc.get('target', '')
        level = dc.get('level', 'WARN')

        if not pattern or not target:
            continue

        check_pattern(
            level=level,
            desc=desc,
            pattern=pattern,
            target_prefixes=[target],
            changed=changed,
        )


def auto_patch_spec(spec_path: Path, identifier: str, desc: str = '待补充（自动修补）') -> bool:
    """
    自动修补框架：将缺失的标识符补入 spec 文件。
    幂等：若标识符已存在于 spec 中则跳过。
    在 spec 文件末尾的表格区域追加一行。

    Returns:
        True = 已修补（新追加）
        False = 已存在或修补失败
    """
    if not spec_path.exists():
        return False

    try:
        content = spec_path.read_text(encoding='utf-8')
    except Exception:
        return False

    # 幂等检查：标识符已存在
    if identifier in content:
        return False

    # 查找表格锚点（| 开头的行），在最后一个表格行之后追加
    lines = content.split('\n')
    last_table_line = -1
    for i, line in enumerate(lines):
        if line.strip().startswith('|'):
            last_table_line = i

    patch_line = f'| `{identifier}` | {desc} |'

    if last_table_line >= 0:
        # 在最后一个表格行后插入
        lines.insert(last_table_line + 1, patch_line)
    else:
        # 无表格，在文件末尾追加一个表格
        if lines and lines[-1].strip():
            lines.append('')
        lines.append(f'| 标识符 | 描述 |')
        lines.append('|-------|------|')
        lines.append(patch_line)

    try:
        spec_path.write_text('\n'.join(lines), encoding='utf-8')
        return True
    except Exception:
        return False


def check_contract_sync(changed: list[Path]) -> None:
    """§行为契约同步：检测契约相关源码变更是否已同步到 spec/"""
    section("§行为契约同步")

    spec_dir = ROOT / 'spec'
    checks_cfg = CONFIG.get('checks', {}).get('contract_sync', {})
    if not checks_cfg.get('enabled', True):
        pass_msg("行为契约同步检查（已禁用）")
        return

    if not spec_dir.exists() or not any(spec_dir.glob('*.md')):
        warn_msg("项目缺少 spec/ 行为契约目录或文件")
        detail("建议：创建 spec/ 目录并编写行为契约（参考 spec/README.md）")
        return

    if ARGS.all:
        pass_msg("行为契约同步检查（全量模式跳过增量比对）")
        return

    spec_mapping = CONFIG.get('spec_mapping', [])
    if not spec_mapping:
        pass_msg("行为契约同步检查（未配置 spec_mapping）")
        return

    auto_patch_enabled = checks_cfg.get('auto_patch', True)
    # 自动修补的标识符提取正则（从 config 读取，如 entity 定义模式）
    auto_patch_pattern = CONFIG.get('rules', {}).get('contract_identifier_pattern', '')

    contract_touched = False

    for mapping in spec_mapping:
        source = mapping.get('source', '')
        contract = mapping.get('contract', '')
        desc = mapping.get('desc', f"源码 {source}")

        if not source or not contract:
            continue

        # 检查该 source 前缀下是否有变更
        source_changed = False
        has_unignored = False
        changed_in_source = []
        for f in changed:
            try:
                rel = str(f.relative_to(ROOT))
                if rel.startswith(source):
                    source_changed = True
                    if not file_has_marker(f, 'selfcheck:ignore-contract'):
                        has_unignored = True
                        changed_in_source.append(f)
            except ValueError:
                continue

        if not source_changed:
            continue
        if not has_unignored:
            continue

        contract_touched = True
        spec_rel = contract
        spec_path = ROOT / spec_rel

        # ── 内容级判定（优先）：自动修补确定性缺失 ──
        # 如果配置了标识符提取正则，从变更源码提取标识符并检查是否已登记
        patched_count = 0
        missing_ids = []
        if auto_patch_enabled and auto_patch_pattern and changed_in_source:
            try:
                id_regex = re.compile(auto_patch_pattern)
            except re.error:
                id_regex = None

            if id_regex:
                found_ids = set()
                for f in changed_in_source:
                    try:
                        content = f.read_text(encoding='utf-8', errors='ignore')
                        for m in id_regex.finditer(content):
                            found_ids.add(m.group(1) if m.groups() else m.group(0))
                    except Exception:
                        continue

                for fid in sorted(found_ids):
                    if spec_path.exists() and fid in spec_path.read_text(encoding='utf-8', errors='ignore'):
                        continue  # 已收录
                    if auto_patch_spec(spec_path, fid):
                        patched_count += 1
                    else:
                        missing_ids.append(fid)

        # ── diff 基判定（兜底）──
        # 检查 spec 文件是否在变更列表中
        spec_changed = any(
            str(f.relative_to(ROOT)) == spec_rel for f in changed
        )

        if patched_count > 0:
            pass_msg(f"{desc} — 契约已同步（自动修补 {patched_count} 项）")
            detail(f"已登记新增标识符至 {spec_path.name}，占位描述请人工补充（或调用 /facai-contract）")
        elif missing_ids:
            warn_msg(f"{desc} — spec 未包含新增标识符且无法自动修补：{', '.join(missing_ids)}")
            detail(f"请调用 /facai-contract 技能更新 {spec_path.name}")
        elif spec_changed or (spec_path.exists() and git('diff', '--name-only', REMOTE_BASE, '--', spec_rel)):
            pass_msg(f"{desc} — 契约已同步")
        else:
            warn_msg(f"{desc} — 源码有变更，spec 可能未同步")
            detail(f"行为变化需语义判断，请调用 /facai-contract 技能更新 {spec_rel}")

    if not contract_touched:
        pass_msg("行为契约同步检查（无契约相关变更）")


def check_compile() -> None:
    """§编译检查"""
    if ARGS.fast:
        section("§编译检查（--fast 已跳过）")
        warn_msg("已跳过编译检查")
        return

    section("§编译检查")
    commands = CONFIG.get('commands', {})
    build_cmd = commands.get('build', '')
    checks_cfg = CONFIG.get('checks', {}).get('compile', {})

    if not checks_cfg.get('enabled', True):
        pass_msg("编译检查（已禁用）")
        return

    if not build_cmd:
        warn_msg("未配置构建命令（commands.build），跳过编译检查")
        return

    try:
        result = subprocess.run(
            build_cmd, shell=True, cwd=str(ROOT),
            capture_output=True, text=True, timeout=300
        )
        if result.returncode == 0:
            pass_msg(f"{build_cmd} 通过")
        else:
            fail_msg(f"{build_cmd} 失败")
            for line in result.stderr.split('\n'):
                if line.strip() and ('error' in line.lower() or 'Error' in line):
                    detail(line.strip())
    except subprocess.TimeoutExpired:
        fail_msg(f"{build_cmd} 超时")
    except Exception as e:
        fail_msg(f"{build_cmd} 执行异常: {e}")

    # 测试检查（从 commands.test 读取）
    test_cmd = commands.get('test', '')
    if test_cmd:
        try:
            result = subprocess.run(
                test_cmd, shell=True, cwd=str(ROOT),
                capture_output=True, text=True, timeout=600
            )
            if result.returncode == 0:
                pass_msg(f"{test_cmd} 通过")
            else:
                fail_msg(f"{test_cmd} 失败")
                for line in result.stderr.split('\n'):
                    if line.strip() and ('FAIL' in line or 'error' in line.lower()):
                        detail(line.strip())
        except subprocess.TimeoutExpired:
            fail_msg(f"{test_cmd} 超时")
        except Exception as e:
            fail_msg(f"{test_cmd} 执行异常: {e}")

    # 可选 lint
    lint_cmd = commands.get('lint', '')
    if lint_cmd:
        try:
            result = subprocess.run(
                lint_cmd, shell=True, cwd=str(ROOT),
                capture_output=True, text=True, timeout=300
            )
            if result.returncode == 0:
                pass_msg(f"{lint_cmd} 无警告")
            else:
                warn_msg(f"{lint_cmd} 有告警（非阻断）")
                for line in result.stderr.split('\n'):
                    if line.strip() and 'warning' in line.lower():
                        detail(line.strip())
        except Exception:
            pass


# ════════════════════════════════════════════
# 主流程
# ════════════════════════════════════════════

class Args:
    fast: bool = False
    all: bool = False

ARGS = Args()

def main() -> None:
    parser = argparse.ArgumentParser(description='facai-selfcheck 代码自检')
    parser.add_argument('--fast', action='store_true', help='仅静态检查，跳过编译')
    parser.add_argument('--all', action='store_true', help='强制全量检查')
    args = parser.parse_args()

    ARGS.fast = args.fast
    ARGS.all = args.all

    global CONFIG
    CONFIG = load_config()

    source_root_str = CONFIG.get('project', {}).get('source_root', 'src')
    REMOTE_BASE_LOCAL = REMOTE_BASE

    # 确定检查范围
    if ARGS.all:
        scan_mode = "全量"
    elif git_has_remote_base():
        scan_mode = f"增量（基准: {REMOTE_BASE_LOCAL}）"
    else:
        scan_mode = f"全量（未找到 {REMOTE_BASE_LOCAL}）"

    changed = get_changed_files()

    # 输出报告头
    print(f"{B}facai 自检报告{N}")
    print(f"项目根: {D}{ROOT}{N}")
    print(f"检查范围: {D}{scan_mode}{N}")
    if not ARGS.all and changed:
        print(f"待检文件: {D}{len(changed)} 个{N}")

    # 运行各检测段
    check_dependency_direction(changed)
    check_import_style(changed)
    check_error_handling(changed)
    check_test_colocation(changed)
    check_test_coverage(changed)
    check_domain_rules(changed)
    check_contract_sync(changed)
    check_compile()

    # 汇总
    header("汇总")
    print(f"  {G}PASS: {stats.pass_count}{N}   {Y}WARN: {stats.warn_count}{N}   {R}FAIL: {stats.fail_count}{N}\n")

    if stats.fail_count > 0:
        print(f"{R}结果: 未通过 —— 请修复上述 FAIL 项{N}")
        sys.exit(1)
    elif stats.warn_count > 0:
        print(f"{Y}结果: 已通过（有 {stats.warn_count} 项 WARN，建议人工确认）{N}")
        sys.exit(0)
    else:
        print(f"{G}结果: 全部通过{N}")
        sys.exit(0)


if __name__ == '__main__':
    main()
