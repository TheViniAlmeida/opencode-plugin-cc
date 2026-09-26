// Every request is rejected with 401 (wrong credentials on the plugin side).
export default {
  setup(fake) {
    fake.rejectAllAuth = true;
  },
};
