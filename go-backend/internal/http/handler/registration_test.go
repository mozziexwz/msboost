package handler

import "testing"

func TestNumericQQMailboxPattern(t *testing.T) {
	valid := []string{"123456@qq.com", "0@qq.com", "987654321@qq.com"}
	for _, email := range valid {
		if !numericQQMailboxPattern.MatchString(email) {
			t.Fatalf("expected numeric QQ mailbox to be accepted: %q", email)
		}
	}

	invalid := []string{
		"12345a@qq.com",
		"abc@qq.com",
		"123456@gmail.com",
		"123456@qq.com.cn",
		" 123456@qq.com",
	}
	for _, email := range invalid {
		if numericQQMailboxPattern.MatchString(email) {
			t.Fatalf("expected invalid mailbox to be rejected: %q", email)
		}
	}
}

func TestPublicConfigNameAllowlist(t *testing.T) {
	for _, name := range []string{"app_name", "app_logo", "app_favicon", "cloudflare_site_key"} {
		if !isPublicConfigName(name) {
			t.Fatalf("expected public config to be allowed: %q", name)
		}
	}

	for _, name := range []string{"cloudflare_secret_key", "registration_invite_code", "panel_domain", "ip"} {
		if isPublicConfigName(name) {
			t.Fatalf("expected non-public config to be rejected: %q", name)
		}
	}
}
