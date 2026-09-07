package handler

import (
	"crypto/subtle"
	"net/http"
	"regexp"
	"strings"
	"time"

	"go-backend/internal/http/response"
	"go-backend/internal/security"
)

var numericQQMailboxPattern = regexp.MustCompile(`^[0-9]+@qq\.com$`)

type registrationSettingsData struct {
	Enabled           bool   `json:"enabled"`
	InviteRequired    bool   `json:"inviteRequired"`
	TurnstileEnabled  bool   `json:"turnstileEnabled"`
	TurnstileSiteKey  string `json:"turnstileSiteKey"`
}

type registrationRequest struct {
	Email             string `json:"email"`
	Password          string `json:"password"`
	InviteCode        string `json:"inviteCode"`
	TurnstileToken    string `json:"turnstileToken"`
	AgreementAccepted bool   `json:"agreementAccepted"`
}

func (h *Handler) registrationSettings(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		response.WriteJSON(w, response.ErrDefault("请求失败"))
		return
	}

	settings, err := h.getRegistrationSettings()
	if err != nil {
		response.WriteJSON(w, response.Err(-2, err.Error()))
		return
	}
	response.WriteJSON(w, response.OK(settings))
}

func (h *Handler) registrationCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		response.WriteJSON(w, response.ErrDefault("请求失败"))
		return
	}

	var req registrationRequest
	if err := decodeJSON(r.Body, &req); err != nil {
		response.WriteJSON(w, response.ErrDefault("注册信息格式错误"))
		return
	}

	settings, err := h.getRegistrationSettings()
	if err != nil {
		response.WriteJSON(w, response.Err(-2, err.Error()))
		return
	}
	if !settings.Enabled {
		response.WriteJSON(w, response.ErrDefault("管理员暂未开放注册"))
		return
	}

	email := strings.ToLower(strings.TrimSpace(req.Email))
	if !numericQQMailboxPattern.MatchString(email) {
		response.WriteJSON(w, response.ErrDefault("仅支持纯数字 QQ 邮箱，例如 123456@qq.com"))
		return
	}
	if len(req.Password) < 8 {
		response.WriteJSON(w, response.ErrDefault("密码长度至少 8 位"))
		return
	}
	if !req.AgreementAccepted {
		response.WriteJSON(w, response.ErrDefault("请先阅读并同意服务协议"))
		return
	}

	if settings.InviteRequired {
		cfg, getErr := h.repo.GetConfigByName("registration_invite_code")
		if getErr != nil {
			response.WriteJSON(w, response.Err(-2, getErr.Error()))
			return
		}
		expected := ""
		if cfg != nil {
			expected = strings.TrimSpace(cfg.Value)
		}
		provided := strings.TrimSpace(req.InviteCode)
		if expected == "" || subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
			response.WriteJSON(w, response.ErrDefault("邀请码无效"))
			return
		}
	}

	if settings.TurnstileEnabled && !h.verifyRegistrationTurnstile(req.TurnstileToken) {
		response.WriteJSON(w, response.ErrDefault("Turnstile 验证失败，请重试"))
		return
	}

	exists, err := h.repo.UserExists(email)
	if err != nil {
		response.WriteJSON(w, response.Err(-2, err.Error()))
		return
	}
	if exists {
		response.WriteJSON(w, response.ErrDefault("该 QQ 邮箱已注册"))
		return
	}

	now := time.Now().UnixMilli()
	userID, err := h.repo.CreateUser(email, security.MD5(req.Password), 1, now, 0, 1, 0, 1, now)
	if err != nil {
		response.WriteJSON(w, response.Err(-2, err.Error()))
		return
	}

	response.WriteJSON(w, response.OK(map[string]interface{}{
		"id":      userID,
		"message": "注册成功，请登录后使用卡密开通套餐",
	}))
}

func (h *Handler) getRegistrationSettings() (registrationSettingsData, error) {
	settings := registrationSettingsData{Enabled: true}
	var err error
	if settings.Enabled, err = h.registrationConfigBool("registration_enabled", true); err != nil {
		return settings, err
	}
	if settings.InviteRequired, err = h.registrationConfigBool("registration_invite_required", false); err != nil {
		return settings, err
	}
	if settings.TurnstileEnabled, err = h.registrationConfigBool("registration_turnstile_enabled", false); err != nil {
		return settings, err
	}
	if !settings.TurnstileEnabled {
		return settings, nil
	}

	siteCfg, err := h.repo.GetConfigByName("cloudflare_site_key")
	if err != nil {
		return settings, err
	}
	secretCfg, err := h.repo.GetConfigByName("cloudflare_secret_key")
	if err != nil {
		return settings, err
	}
	if siteCfg == nil || secretCfg == nil || strings.TrimSpace(siteCfg.Value) == "" || strings.TrimSpace(secretCfg.Value) == "" {
		settings.TurnstileEnabled = false
		return settings, nil
	}
	settings.TurnstileSiteKey = strings.TrimSpace(siteCfg.Value)
	return settings, nil
}

func (h *Handler) registrationConfigBool(name string, fallback bool) (bool, error) {
	cfg, err := h.repo.GetConfigByName(name)
	if err != nil {
		return fallback, err
	}
	if cfg == nil {
		return fallback, nil
	}
	switch strings.ToLower(strings.TrimSpace(cfg.Value)) {
	case "true", "1", "yes", "on":
		return true, nil
	case "false", "0", "no", "off", "":
		return false, nil
	default:
		return fallback, nil
	}
}

func (h *Handler) verifyRegistrationTurnstile(token string) bool {
	cfg, err := h.repo.GetConfigByName("cloudflare_secret_key")
	if err != nil || cfg == nil {
		return false
	}
	return h.verifyCloudflareTurnstile(strings.TrimSpace(token), strings.TrimSpace(cfg.Value))
}
