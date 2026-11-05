fn main() {
    mytowncart_billing_lib::run(std::env::var("MTC_DRIVER_SCRIPT").ok());
}
