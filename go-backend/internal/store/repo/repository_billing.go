package repo

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"go-backend/internal/store/model"

	"gorm.io/gorm"
)

var (
	ErrPlanNotFound   = errors.New("plan not found")
	ErrCardNotFound   = errors.New("card not found")
	ErrCardUnavailable = errors.New("card unavailable")
)

// CardRecord is deliberately free of the card digest so administrative list
// views cannot disclose a redeemable credential from database backups.
type CardRecord struct {
	ID               int64  `json:"id"`
	PlanID           int64  `json:"planId"`
	PlanName         string `json:"planName"`
	Status           int    `json:"status"`
	RedeemedByUserID int64  `json:"redeemedByUserId"`
	RedeemedTime     int64  `json:"redeemedTime"`
	CreatedTime      int64  `json:"createdTime"`
}

func (r *Repository) ListPlans(enabledOnly bool) ([]model.Plan, error) {
	if r == nil || r.db == nil {
		return nil, errors.New("repository not initialized")
	}
	query := r.db.Order("sort_order ASC, id ASC")
	if enabledOnly {
		query = query.Where("enabled = ?", 1)
	}
	var plans []model.Plan
	if err := query.Find(&plans).Error; err != nil {
		return nil, err
	}
	return plans, nil
}

func (r *Repository) GetPlan(id int64) (*model.Plan, error) {
	if r == nil || r.db == nil {
		return nil, errors.New("repository not initialized")
	}
	var plan model.Plan
	err := r.db.Where("id = ?", id).First(&plan).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &plan, nil
}

func (r *Repository) CreatePlan(plan *model.Plan) error {
	if r == nil || r.db == nil {
		return errors.New("repository not initialized")
	}
	if plan == nil {
		return errors.New("plan is required")
	}
	return r.db.Create(plan).Error
}

func (r *Repository) UpdatePlan(plan *model.Plan) error {
	if r == nil || r.db == nil {
		return errors.New("repository not initialized")
	}
	if plan == nil || plan.ID <= 0 {
		return ErrPlanNotFound
	}
	result := r.db.Model(&model.Plan{}).Where("id = ?", plan.ID).Updates(map[string]interface{}{
		"name":            plan.Name,
		"days":            plan.Days,
		"flow_gb":         plan.FlowGB,
		"bandwidth_mbps":  plan.BandwidthMbps,
		"price_cents":     plan.PriceCents,
		"enabled":         plan.Enabled,
		"trial":           plan.Trial,
		"sort_order":      plan.SortOrder,
		"updated_time":    plan.UpdatedTime,
	})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return ErrPlanNotFound
	}
	return nil
}

func (r *Repository) DeletePlan(id int64) error {
	if r == nil || r.db == nil {
		return errors.New("repository not initialized")
	}
	return r.db.Transaction(func(tx *gorm.DB) error {
		var cardCount int64
		if err := tx.Model(&model.Card{}).Where("plan_id = ?", id).Count(&cardCount).Error; err != nil {
			return err
		}
		if cardCount > 0 {
			return errors.New("plan has issued cards")
		}
		result := tx.Delete(&model.Plan{}, id)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return ErrPlanNotFound
		}
		return nil
	})
}

func (r *Repository) GenerateCards(planID int64, count int, now int64) ([]string, error) {
	if r == nil || r.db == nil {
		return nil, errors.New("repository not initialized")
	}
	if count < 1 || count > 500 {
		return nil, errors.New("card count must be between 1 and 500")
	}

	codes := make([]string, 0, count)
	err := r.db.Transaction(func(tx *gorm.DB) error {
		var plan model.Plan
		if err := tx.Where("id = ?", planID).First(&plan).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlanNotFound
			}
			return err
		}

		for i := 0; i < count; i++ {
			code, err := newCardCode()
			if err != nil {
				return err
			}
			card := model.Card{CodeHash: hashCardCode(code), PlanID: planID, Status: 0, CreatedTime: now}
			if err := tx.Create(&card).Error; err != nil {
				return err
			}
			codes = append(codes, code)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return codes, nil
}

func (r *Repository) ListCards(planID int64) ([]CardRecord, error) {
	if r == nil || r.db == nil {
		return nil, errors.New("repository not initialized")
	}
	query := r.db.Table("card").
		Select("card.id, card.plan_id, plan.name AS plan_name, card.status, card.redeemed_by_user_id, card.redeemed_time, card.created_time").
		Joins("LEFT JOIN plan ON plan.id = card.plan_id").
		Order("card.id DESC")
	if planID > 0 {
		query = query.Where("card.plan_id = ?", planID)
	}
	var cards []CardRecord
	if err := query.Find(&cards).Error; err != nil {
		return nil, err
	}
	return cards, nil
}

func (r *Repository) RedeemCard(userID int64, rawCode string, now int64) (*model.Plan, error) {
	if r == nil || r.db == nil {
		return nil, errors.New("repository not initialized")
	}
	hash := hashCardCode(rawCode)
	var redeemedPlan model.Plan

	err := r.db.Transaction(func(tx *gorm.DB) error {
		var card model.Card
		if err := tx.Where("code_hash = ?", hash).First(&card).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrCardNotFound
			}
			return err
		}
		if card.Status != 0 {
			return ErrCardUnavailable
		}

		if err := tx.Where("id = ?", card.PlanID).First(&redeemedPlan).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlanNotFound
			}
			return err
		}
		if redeemedPlan.Enabled != 1 {
			return errors.New("plan disabled")
		}

		expiresAt := time.UnixMilli(now).Add(time.Duration(redeemedPlan.Days) * 24 * time.Hour).UnixMilli()
		userResult := tx.Model(&model.User{}).Where("id = ?", userID).Updates(map[string]interface{}{
			"exp_time":        expiresAt,
			"flow":            redeemedPlan.FlowGB,
			"in_flow":         0,
			"out_flow":        0,
			"flow_reset_time": 0,
			"num":             1,
			"status":          1,
			"updated_time":    now,
		})
		if userResult.Error != nil {
			return userResult.Error
		}
		if userResult.RowsAffected == 0 {
			return errors.New("user not found")
		}

		if err := tx.Model(&model.UserTunnel{}).Where("user_id = ?", userID).Updates(map[string]interface{}{
			"exp_time":        expiresAt,
			"flow":            redeemedPlan.FlowGB,
			"in_flow":         0,
			"out_flow":        0,
			"flow_reset_time": 0,
			"num":             1,
			"status":          1,
		}).Error; err != nil {
			return err
		}

		cardResult := tx.Model(&model.Card{}).Where("id = ? AND status = ?", card.ID, 0).Updates(map[string]interface{}{
			"status":              1,
			"redeemed_by_user_id": userID,
			"redeemed_time":       now,
		})
		if cardResult.Error != nil {
			return cardResult.Error
		}
		if cardResult.RowsAffected != 1 {
			return ErrCardUnavailable
		}

		return nil
	})
	if err != nil {
		return nil, err
	}
	return &redeemedPlan, nil
}

func hashCardCode(code string) string {
	canonical := strings.ToUpper(strings.TrimSpace(code))
	digest := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(digest[:])
}

func newCardCode() (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	buf := make([]byte, 20)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate card code: %w", err)
	}
	var out strings.Builder
	out.WriteString("MSB-")
	for i, b := range buf {
		if i > 0 && i%5 == 0 {
			out.WriteByte('-')
		}
		out.WriteByte(alphabet[int(b)%len(alphabet)])
	}
	return out.String(), nil
}
