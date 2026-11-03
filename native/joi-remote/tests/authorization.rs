use joi_remote::{
    authorization::{AuthorizationError, PairingAuthority},
    protocol::PAIRING_TTL_MS,
};

#[test]
fn pairing_is_single_use_and_authorizes_independent_devices() {
    let mut authority = PairingAuthority::new();
    let first_offer = authority.create_offer(1_000, PAIRING_TTL_MS);
    let first_request = authority
        .request_pairing(
            2_000,
            &first_offer.offer_id,
            &first_offer.secret,
            "phone-a",
            "Pixel A",
        )
        .expect("first phone pairing request");
    let first = authority
        .approve(3_000, &first_request.request_id)
        .expect("approve first phone");

    assert!(authority.authorize("phone-a", &first.token));
    assert_eq!(
        authority.request_pairing(
            4_000,
            &first_offer.offer_id,
            &first_offer.secret,
            "replay",
            "Replay"
        ),
        Err(AuthorizationError::OfferConsumed),
    );

    let second_offer = authority.create_offer(5_000, PAIRING_TTL_MS);
    let second_request = authority
        .request_pairing(
            6_000,
            &second_offer.offer_id,
            &second_offer.secret,
            "phone-b",
            "Pixel B",
        )
        .expect("second phone pairing request");
    let second = authority
        .approve(7_000, &second_request.request_id)
        .expect("approve second phone");

    assert!(authority.authorize("phone-a", &first.token));
    assert!(authority.authorize("phone-b", &second.token));
    assert!(!authority.authorize("phone-a", &second.token));
}

#[test]
fn expired_offer_and_targeted_revocation_fail_closed() {
    let mut authority = PairingAuthority::new();
    let expired = authority.create_offer(10_000, 100);
    assert_eq!(
        authority.request_pairing(
            10_101,
            &expired.offer_id,
            &expired.secret,
            "late",
            "Late phone"
        ),
        Err(AuthorizationError::OfferExpired),
    );

    let offer = authority.create_offer(20_000, PAIRING_TTL_MS);
    let request = authority
        .request_pairing(20_001, &offer.offer_id, &offer.secret, "phone", "Phone")
        .expect("request");
    let device = authority
        .approve(20_002, &request.request_id)
        .expect("approve");
    assert!(authority.authorize("phone", &device.token));
    authority.revoke("phone").expect("revoke");
    assert!(!authority.authorize("phone", &device.token));
    assert_eq!(
        authority.revoke("phone"),
        Err(AuthorizationError::DeviceNotFound)
    );
}
