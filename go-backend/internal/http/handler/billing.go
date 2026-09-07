package handler

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"go-backend/internal/auth"
	"go-backend/internal/http/middleware"
	"go-backend/internal/http/response"
	"go-backend/internal/store/model"
	"go-backend/internal/store/repo"
)

type planRequest struct {
	ID            int64  `json:"id"`
	Name          string `json:"name"`
	Days          int    `json:"days"`
	FlowGB        int64  `json:"flowGB"`
	BandwidthMbps int    `json:"bandwidthMbps"`
	PriceCents    int64  `json:"priceCents"`
	Enabled       int    `json:"enabled"`
	Trial         int    `json:"trial"`
	SortOrder     int    `json:"sortOrder"`
}

type planDeleteRequest struct {
	ID int64 `json:"id"`
}

type cardGenerateRequest struct {
	PlanID int64 `json:"planId"`
	Count  int   `json:"count"`
}

type cardListRequest struct {
	PlanID int64 `json:"planId"`
}

type cardRedeemRequest struct {
	Code string `json:"code"`
}

func (h *Handler) planList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		response.WriteJSON(w, response.ErrDefault("请求失败"))
		return
	}
	claims, ok := claimsFromRequest(r)
	if !ok {
		response.WriteJSON(w, response.Err(http.StatusUnauthorized, "无效的token或token已过期"))
		return
	}
	plans, err := h.repo.ListPlans(claims.RoleID != 0)
	if err != nil {
		response.WriteJSON(w, response.Err(-2, err.Error()))
		return
	}
	response.WriteJSON(w, response.OK(planViews(plans)))
}

func (h *Handler) planCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		response.WriteJSON(w, response.ErrDefault("请求失败"))
		return
	}
	if !isAdminRequest(r) {
		response.WriteJSON(w, response.Err(http.StatusForbidden, "权限不足，仅管理员可操作"))
		return
	}
	var req planRequest
	if err := decodeJSON(r.Body, &req); err != nil {
		response.WriteJSON(w, response.ErrDefault("套餐信息格式错误"))
		return
	}
	plan, err := planFromRequest(req, 0)
	if err != nil {
		response.WriteJSON(w, response.ErrDefault(err.Error()))
		return
	}
	now := time.Now().UnixMilli()
	plan.CreatedTime = now
	plan.UpdatedTime = now
	if err := h.repo.CreatePlan(&plan); err != nil {
		response.WriteJSON(w, response.Err(-2, err.Error()))
		return
	}
	response.WriteJSON(w, response.OK(planView(plan)))
}

func (h *Handler) planUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		response.WriteJSON(w, response.ErrDefault("请求失败"))
		return
	}
	if !isAdminRequest(r) {
		response.WriteJSON(w, response.Err(http.StatusForbidden, "权限不足，仅管理员可操作"))
		return
	}
	var req planRequest
	if err := decodeJSON(r.Body, &req); err != nil || req.ID <= 0 {
		response.WriteJSON(w, response.ErrDefault("套餐信息格式错误"))
		return
	}
	plan, err := planFromRequest(req, req.ID)
	if err != nil {
		response.WriteJSON(w, response.ErrDefault(err.Error()))
		return
	}
	plan.UpdatedTime = time.Now().UnixMilli()
	if err := h.repo.UpdatePlan(&plan); err != nil {
		writeBillingError(w, err)
		return
	}
	response.WriteJSON(w, response.OK(planView(plan)))
}

func (h *Handler) planDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		response.WriteJSON(w, response.ErrDefault("请求失败"))
		return
	}
	if !isAdminRequest(r) {
		response.WriteJSON(w, response.Err(http.StatusForbidden, "权限不足，仅管理员可操作"))
		return
	}
	var req planDeleteRequest
	if err := decodeJSON(r.Body, &req); err != nil || req.ID <= 0 {
		response.WriteJSON(w, response.ErrDefault("套餐不存在"))
		return
	}
	if err := h.repo.DeletePlan(req.ID); err != nil {
		writeBillingError(w, err)
		return
	}
	response.WriteJSON(w, response.OKEmpty())
}

func (h *Handler) cardGenerate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		response.WriteJSON(w, response.ErrDefault("请求失败"))
		return
	}
	if !isAdminRequest(r) {
		response.WriteJSON(w, response.Err(http.StatusForbidden, "权限不足，仅管理员可操作"))
		return
	}
	var req cardGenerateRequest
	if err := decodeJSON(r.Body, &req); err != nil || req.PlanID <= 0 {
		response.WriteJSON(w, response.ErrDefault("卡密信息格式错误"))
		return
	}
	codes, err := h.repo.GenerateCards(req.PlanID, req.Count, time.Now().UnixMilli())
	if err != nil {
		writeBillingError(w, err)
		return
	}
	response.WriteJSON(w, response.OK(map[string]interface{}{
		"codes":   codes,
		"message": "卡密仅在本次生成结果中显示，请立即安全保存",
	}))
}

func (h *Handler) cardList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		response.WriteJSON(w, response.ErrDefault("请求失败"))
		return
	}
	if !isAdminRequest(r) {
		response.WriteJSON(w, response.Err(http.StatusForbidden, "权限不足，仅管理员可操作"))
		return
	}
	var req cardListRequest
	if err := decodeJSON(r.Body, &req); err != nil {
		response.WriteJSON(w, response.ErrDefault("查询参数错误"))
		return
	}
	cards, err := h.repo.ListCards(req.PlanID)
	if err != nil {
		response.WriteJSON(w, response.Err(-2, err.Error()))
		return
	}
	response.WriteJSON(w, response.OK(cards))
}

func (h *Handler) cardRedeem(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		response.WriteJSON(w, response.ErrDefault("请求失败"))
		return
	}
	userID, ok := requestUserID(r)
	if !ok {
		response.WriteJSON(w, response.Err(http.StatusUnauthorized, "无效的token或token已过期"))
		return
	}
	var req cardRedeemRequest
	if err := decodeJSON(r.Body, &req); err != nil {
		response.WriteJSON(w, response.ErrDefault("卡密格式错误"))
		return
	}
	if strings.TrimSpace(req.Code) == "" {
		response.WriteJSON(w, response.ErrDefault("请输入卡密"))
		return
	}
	plan, err := h.repo.RedeemCard(userID, req.Code, time.Now().UnixMilli())
	if err != nil {
		writeBillingError(w, err)
		return
	}
	response.WriteJSON(w, response.OK(map[string]interface{}{
		"plan":    planView(*plan),
		"message": "套餐已开通；新套餐流量已覆盖旧额度并从零开始统计",
	}))
}

func claimsFromRequest(r *http.Request) (auth.Claims, bool) {
	claims, ok := r.Context().Value(middleware.ClaimsContextKey).(auth.Claims)
	return claims, ok
}

func requestUserID(r *http.Request) (int64, bool) {
	claims, ok := claimsFromRequest(r)
	if !ok {
		return 0, false
	}
	id, err := parseUserID(claims.Sub)
	return id, err == nil && id > 0
}

func isAdminRequest(r *http.Request) bool {
	claims, ok := claimsFromRequest(r)
	return ok && claims.RoleID == 0
}

func planFromRequest(req planRequest, id int64) (model.Plan, error) {
	plan := model.Plan{
		ID:            id,
		Name:          strings.TrimSpace(req.Name),
		Days:          req.Days,
		FlowGB:        req.FlowGB,
		BandwidthMbps: req.BandwidthMbps,
		PriceCents:    req.PriceCents,
		Enabled:       req.Enabled,
		Trial:         req.Trial,
		SortOrder:     req.SortOrder,
	}
	if plan.Name == "" || len([]rune(plan.Name)) > 100 {
		return plan, errors.New("套餐名称不能为空且不得超过 100 个字符")
	}
	if plan.Days < 1 || plan.Days > 31 {
		return plan, errors.New("套餐有效期必须为 1 至 31 天")
	}
	if plan.FlowGB < 0 || plan.BandwidthMbps < 0 || plan.PriceCents < 0 {
		return plan, errors.New("套餐流量、带宽和价格不能为负数")
	}
	if (plan.Enabled != 0 && plan.Enabled != 1) || (plan.Trial != 0 && plan.Trial != 1) {
		return plan, errors.New("套餐开关值无效")
	}
	return plan, nil
}

func planView(plan model.Plan) map[string]interface{} {
	return map[string]interface{}{
		"id":             plan.ID,
		"name":           plan.Name,
		"days":           plan.Days,
		"flowGB":         plan.FlowGB,
		"bandwidthMbps":  plan.BandwidthMbps,
		"priceCents":     plan.PriceCents,
		"enabled":        plan.Enabled,
		"trial":          plan.Trial,
		"sortOrder":      plan.SortOrder,
		"createdTime":    plan.CreatedTime,
		"updatedTime":    plan.UpdatedTime,
	}
}

func planViews(plans []model.Plan) []map[string]interface{} {
	items := make([]map[string]interface{}, 0, len(plans))
	for _, plan := range plans {
		items = append(items, planView(plan))
	}
	return items
}

func writeBillingError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, repo.ErrPlanNotFound):
		response.WriteJSON(w, response.ErrDefault("套餐不存在"))
	case errors.Is(err, repo.ErrCardNotFound):
		response.WriteJSON(w, response.ErrDefault("卡密无效"))
	case errors.Is(err, repo.ErrCardUnavailable):
		response.WriteJSON(w, response.ErrDefault("卡密已使用或已失效"))
	case strings.Contains(err.Error(), "plan has issued cards"):
		response.WriteJSON(w, response.ErrDefault("该套餐已有已发放卡密，不能删除；请先停用套餐"))
	case strings.Contains(err.Error(), "plan disabled"):
		response.WriteJSON(w, response.ErrDefault("该卡密对应套餐已停用"))
	default:
		response.WriteJSON(w, response.Err(-2, err.Error()))
	}
}
