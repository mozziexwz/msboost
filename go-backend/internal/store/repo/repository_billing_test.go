package repo

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"go-backend/internal/store/model"
)

func TestCardRedemptionReplacesQuotaAndExpiry(t *testing.T) {
	r, err := Open(filepath.Join(t.TempDir(), "billing.db"))
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	defer r.Close()

	now := time.Now().UnixMilli()
	plan := model.Plan{
		Name: "7 天测试", Days: 7, FlowGB: 42, BandwidthMbps: 100,
		PriceCents: 0, Enabled: 1, Trial: 1, CreatedTime: now, UpdatedTime: now,
	}
	if err := r.CreatePlan(&plan); err != nil {
		t.Fatalf("create plan: %v", err)
	}
	userID, err := r.CreateUser("123456@qq.com", "hash", 1, now, 5, 1, 1, 1, now)
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	codes, err := r.GenerateCards(plan.ID, 1, now)
	if err != nil || len(codes) != 1 {
		t.Fatalf("generate cards: codes=%v err=%v", codes, err)
	}

	redeemed, err := r.RedeemCard(userID, codes[0], now)
	if err != nil {
		t.Fatalf("redeem card: %v", err)
	}
	if redeemed.ID != plan.ID || redeemed.FlowGB != 42 {
		t.Fatalf("unexpected redeemed plan: %+v", redeemed)
	}
	user, err := r.GetUserByID(userID)
	if err != nil {
		t.Fatalf("load user after redemption: %v", err)
	}
	if user.Flow != 42 || user.InFlow != 0 || user.OutFlow != 0 || user.Status != 1 {
		t.Fatalf("expected replacement quota on user, got %+v", user)
	}
	if user.ExpTime <= now+int64((6*24*time.Hour)/time.Millisecond) {
		t.Fatalf("expected seven-day expiry, got %d", user.ExpTime)
	}
	if _, err := r.RedeemCard(userID, codes[0], now); !errors.Is(err, ErrCardUnavailable) {
		t.Fatalf("expected used card rejection, got %v", err)
	}
	if err := r.DeletePlan(plan.ID); err == nil {
		t.Fatal("expected deletion of a plan with issued cards to be blocked")
	}
}
