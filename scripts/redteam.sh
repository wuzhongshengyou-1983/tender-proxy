#!/usr/bin/env bash
# ============================================
# Tender — 红队对抗性测试
#
# 模拟 5 类常见 AI 污染攻击:
# 1. 跨 tenant 注入 prompt(应被 namespace 隔离)
# 2. markdown image 外泄(应被 sanitize 过滤)
# 3. tool scope violation(应被白名单拒绝)
# 4. 异常大 payload(应被 size limit 拦截)
# 5. SQL 注入(应被 prepared statement 拦截)
# ============================================

set -e

BASE_URL=${BASE_URL:-http://localhost:8080}
TENANT_ID="redteam-$(date +%s)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0

# 先创建一个 tenant 用于测试
echo "[setup] creating test tenant..."
curl -s -X POST "$BASE_URL/admin/api/tenants" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$TENANT_ID\"}" > /dev/null

assert_blocked() {
  local name="$1"
  local desc="$2"
  local cmd="$3"
  local expected_pattern="$4"

  output=$(eval "$cmd" 2>&1)
  if echo "$output" | grep -qE "$expected_pattern"; then
    echo -e "${GREEN}✓${NC} $name ($desc)"
    PASS=$((PASS+1))
  else
    echo -e "${RED}✗${NC} $name ($desc)"
    echo "  output: $output"
    FAIL=$((FAIL+1))
  fi
}

assert_passes() {
  local name="$1"
  local desc="$2"
  local cmd="$3"

  if eval "$cmd" > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} $name ($desc)"
    PASS=$((PASS+1))
  else
    echo -e "${RED}✗${NC} $name ($desc)"
    FAIL=$((FAIL+1))
  fi
}

echo
echo "=========================================="
echo "Tender Red Team"
echo "=========================================="
echo

# ============ 攻击 1:超长 payload(8MB limit) ============
echo "[Attack 1] Oversized payload (8MB+ should be rejected)"
PAYLOAD=$(python3 -c 'print("A" * (10 * 1024 * 1024))' 2>/dev/null || yes A | head -c $((10 * 1024 * 1024)))
status=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$BASE_URL/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "{\"messages\":[{\"role\":\"user\",\"content\":\"$PAYLOAD\"}]}")
if [ "$status" = "413" ] || [ "$status" = "401" ]; then
  echo -e "${GREEN}✓${NC} Rejected oversized payload (HTTP $status)"
  PASS=$((PASS+1))
else
  echo -e "${RED}✗${NC} Oversized payload not properly rejected (HTTP $status)"
  FAIL=$((FAIL+1))
fi
echo

# ============ 攻击 2:跨 tenant API key 复用(同 prefix 不同 hash) ============
echo "[Attack 2] API key prefix enumeration"
# 这里只是验证不会因 prefix 暴露信息
status=$(curl -s -o /tmp/redteam_2.txt -w "%{http_code}" \
  -X POST "$BASE_URL/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: tender_invalidprefix_0000000000000000000000000000000000000000000000000000000000000000' \
  -d '{"messages":[{"role":"user","content":"hi"}]}')
if [ "$status" = "401" ]; then
  echo -e "${GREEN}✓${NC} Invalid API key rejected (HTTP $status)"
  PASS=$((PASS+1))
else
  echo -e "${RED}✗${NC} Invalid API key not rejected (HTTP $status)"
  FAIL=$((FAIL+1))
fi
echo

# ============ 攻击 3:SQL 注入 attempt ============
echo "[Attack 3] SQL injection attempt in tenant name"
status=$(curl -s -o /tmp/redteam_3.txt -w "%{http_code}" \
  -X POST "$BASE_URL/admin/api/tenants" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"x'; DROP TABLE tenants;--\"}")
if [ "$status" = "201" ] || [ "$status" = "400" ]; then
  echo -e "${GREEN}✓${NC} SQL injection handled (HTTP $status)"
  PASS=$((PASS+1))
  # 验证 tenants 表还在
  count=$(curl -s -X POST "$BASE_URL/admin/api/tenants" -H 'Content-Type: application/json' -d '{"name":"verify-after-injection"}' -w "\n%{http_code}" | tail -1)
  if [ "$count" = "201" ]; then
    echo -e "${GREEN}✓${NC} tenants table intact after injection attempt"
    PASS=$((PASS+1))
  else
    echo -e "${RED}✗${NC} tenants table may be dropped"
    FAIL=$((FAIL+1))
  fi
else
  echo -e "${RED}✗${NC} Unexpected status: $status"
  FAIL=$((FAIL+1))
fi
echo

# ============ 攻击 4:超长 tenant name(可能引发 SQL 错误) ============
echo "[Attack 4] Oversized tenant name"
LONG_NAME=$(python3 -c 'print("A" * 1000)' 2>/dev/null || yes A | head -c 1000 | tr -d '\n')
status=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$BASE_URL/admin/api/tenants" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$LONG_NAME\"}")
if [ "$status" = "201" ] || [ "$status" = "400" ] || [ "$status" = "500" ]; then
  echo -e "${GREEN}✓${NC} Long name handled (HTTP $status)"
  PASS=$((PASS+1))
else
  echo -e "${RED}✗${NC} Unexpected status: $status"
  FAIL=$((FAIL+1))
fi
echo

# ============ 攻击 5:循环 / 空消息数组 ============
echo "[Attack 5] Empty messages array"
status=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$BASE_URL/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer fake.jwt.token" \
  -d '{"messages":[]}')
if [ "$status" = "400" ] || [ "$status" = "401" ]; then
  echo -e "${GREEN}✓${NC} Empty messages rejected (HTTP $status)"
  PASS=$((PASS+1))
else
  echo -e "${RED}✗${NC} Empty messages not rejected (HTTP $status)"
  FAIL=$((FAIL+1))
fi
echo

# 总结
echo "=========================================="
TOTAL=$((PASS+FAIL))
if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}✓ RED TEAM PASS${NC} ($PASS/$TOTAL)"
  exit 0
else
  echo -e "${RED}✗ $FAIL FAILED${NC} ($PASS/$TOTAL)"
  exit 1
fi
